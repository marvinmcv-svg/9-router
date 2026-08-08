import type { Syscall } from "@/kernel/types";
import { google } from "./auth";

const API = "https://www.googleapis.com/calendar/v3";

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string; organizer?: boolean }[];
  hangoutLink?: string;
}

function summarizeEvent(event: CalendarEvent) {
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start: event.start.dateTime ?? event.start.date,
    end: event.end?.dateTime ?? event.end?.date,
    allDay: Boolean(event.start.date),
    location: event.location,
    meetingLink: event.hangoutLink,
    attendees: event.attendees?.map((a) => ({ email: a.email, status: a.responseStatus })),
    link: event.htmlLink,
  };
}

export const calendarSyscalls: Syscall[] = [
  {
    name: "calendar.list_events",
    connector: "google",
    risk: "read",
    description:
      "List calendar events in a time range, ordered by start time. Call this for anything that depends on the user's schedule — what's on today, whether they're free, when a meeting is, how busy next week looks. Always check the calendar before proposing a time to anyone.",
    input: {
      type: "object",
      properties: {
        timeMin: {
          type: "string",
          description: "ISO 8601 start of range. Defaults to now.",
        },
        timeMax: {
          type: "string",
          description: "ISO 8601 end of range. Defaults to 7 days after timeMin.",
        },
        calendarId: {
          type: "string",
          description: "Calendar id. Defaults to 'primary'.",
        },
        limit: { type: "integer", description: "Maximum events. Default 25." },
      },
      additionalProperties: false,
    },
    async run(input: { timeMin?: string; timeMax?: string; calendarId?: string; limit?: number }) {
      const timeMin = input.timeMin ? new Date(input.timeMin) : new Date();
      const timeMax = input.timeMax
        ? new Date(input.timeMax)
        : new Date(timeMin.getTime() + 7 * 86_400_000);

      const params = new URLSearchParams({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        // Recurring events must be expanded, or "what's on Tuesday" misses
        // every weekly standup.
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(Math.min(input.limit ?? 25, 100)),
      });

      const data = await google<{ items: CalendarEvent[] }>(
        `${API}/calendars/${encodeURIComponent(input.calendarId ?? "primary")}/events?${params}`,
      );

      if (!data.items.length) return "No events in that range.";
      return data.items.filter((e) => e.status !== "cancelled").map(summarizeEvent);
    },
  },

  {
    name: "calendar.find_free_time",
    connector: "google",
    risk: "read",
    description:
      "Find open slots of a given length within a window, accounting for existing events. Use this before proposing meeting times to anyone — never suggest a time you haven't checked against the calendar.",
    input: {
      type: "object",
      properties: {
        durationMinutes: { type: "integer", description: "Length of slot needed." },
        timeMin: { type: "string", description: "ISO 8601 start of search window." },
        timeMax: { type: "string", description: "ISO 8601 end of search window." },
        workdayStartHour: {
          type: "integer",
          description: "Earliest acceptable hour, local, 0-23. Default 9.",
        },
        workdayEndHour: {
          type: "integer",
          description: "Latest acceptable end hour, local, 0-23. Default 18.",
        },
      },
      required: ["durationMinutes", "timeMin", "timeMax"],
      additionalProperties: false,
    },
    async run(input: {
      durationMinutes: number;
      timeMin: string;
      timeMax: string;
      workdayStartHour?: number;
      workdayEndHour?: number;
    }) {
      const timeMin = new Date(input.timeMin);
      const timeMax = new Date(input.timeMax);
      const dayStart = input.workdayStartHour ?? 9;
      const dayEnd = input.workdayEndHour ?? 18;
      const durationMs = input.durationMinutes * 60_000;

      const busy = await google<{ calendars: Record<string, { busy: { start: string; end: string }[] }> }>(
        `${API}/freeBusy`,
        {
          method: "POST",
          body: JSON.stringify({
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            items: [{ id: "primary" }],
          }),
        },
      );

      const blocks = (busy.calendars.primary?.busy ?? [])
        .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
        .sort((a, b) => a.start - b.start);

      const slots: { start: string; end: string }[] = [];
      let cursor = timeMin.getTime();

      while (cursor + durationMs <= timeMax.getTime() && slots.length < 12) {
        const candidateEnd = cursor + durationMs;
        const start = new Date(cursor);
        const end = new Date(candidateEnd);

        // Outside working hours: jump to the next day's opening bell rather
        // than stepping through the night in 15-minute increments.
        if (start.getHours() < dayStart) {
          start.setHours(dayStart, 0, 0, 0);
          cursor = start.getTime();
          continue;
        }
        if (end.getHours() >= dayEnd || end.getDate() !== start.getDate()) {
          const next = new Date(cursor);
          next.setDate(next.getDate() + 1);
          next.setHours(dayStart, 0, 0, 0);
          cursor = next.getTime();
          continue;
        }

        const conflict = blocks.find((b) => b.start < candidateEnd && b.end > cursor);
        if (conflict) {
          cursor = conflict.end;
          continue;
        }

        slots.push({ start: start.toISOString(), end: end.toISOString() });
        cursor = candidateEnd;
      }

      if (!slots.length) return "No free slots of that length in the window.";
      return slots;
    },
  },

  {
    name: "calendar.create_event",
    connector: "google",
    risk: "write",
    description:
      "Create a calendar event, optionally inviting attendees. Check calendar.find_free_time first so you're proposing a slot that's actually open. Inviting attendees emails them, so the approval card shows the full invite.",
    input: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start time." },
        end: { type: "string", description: "ISO 8601 end time." },
        description: { type: "string" },
        location: { type: "string" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses to invite. Omit for a solo block.",
        },
        addMeetLink: { type: "boolean", description: "Attach a Google Meet link." },
      },
      required: ["title", "start", "end"],
      additionalProperties: false,
    },
    preview: (input: { title: string; start: string; end: string; attendees?: string[] }) => {
      const when = `${new Date(input.start).toLocaleString()} → ${new Date(input.end).toLocaleTimeString()}`;
      const who = input.attendees?.length ? ` · invites ${input.attendees.join(", ")}` : "";
      return `Create "${input.title}" ${when}${who}`;
    },
    async run(input: {
      title: string;
      start: string;
      end: string;
      description?: string;
      location?: string;
      attendees?: string[];
      addMeetLink?: boolean;
    }) {
      const params = new URLSearchParams({
        sendUpdates: input.attendees?.length ? "all" : "none",
        ...(input.addMeetLink ? { conferenceDataVersion: "1" } : {}),
      });

      const event = await google<CalendarEvent>(`${API}/calendars/primary/events?${params}`, {
        method: "POST",
        body: JSON.stringify({
          summary: input.title,
          description: input.description,
          location: input.location,
          start: { dateTime: new Date(input.start).toISOString() },
          end: { dateTime: new Date(input.end).toISOString() },
          attendees: input.attendees?.map((email) => ({ email })),
          ...(input.addMeetLink
            ? {
                conferenceData: {
                  createRequest: {
                    requestId: `jarvis-${Date.now()}`,
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                  },
                },
              }
            : {}),
        }),
      });

      return `Created "${input.title}" — ${event.htmlLink}`;
    },
  },

  {
    name: "calendar.update_event",
    connector: "google",
    risk: "write",
    description:
      "Move, rename, or otherwise change an existing event. Use for rescheduling. Only the fields you pass are changed.",
    input: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Event id from calendar.list_events." },
        title: { type: "string" },
        start: { type: "string", description: "New ISO 8601 start time." },
        end: { type: "string", description: "New ISO 8601 end time." },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
    preview: (input: { eventId: string; title?: string; start?: string }) =>
      `Update event ${input.eventId}${input.title ? ` → "${input.title}"` : ""}${
        input.start ? ` at ${new Date(input.start).toLocaleString()}` : ""
      }`,
    async run(input: {
      eventId: string;
      title?: string;
      start?: string;
      end?: string;
      description?: string;
      location?: string;
    }) {
      const patch: Record<string, unknown> = {};
      if (input.title) patch.summary = input.title;
      if (input.description) patch.description = input.description;
      if (input.location) patch.location = input.location;
      if (input.start) patch.start = { dateTime: new Date(input.start).toISOString() };
      if (input.end) patch.end = { dateTime: new Date(input.end).toISOString() };

      const event = await google<CalendarEvent>(
        `${API}/calendars/primary/events/${input.eventId}?sendUpdates=all`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      return `Updated "${event.summary}" — ${event.htmlLink}`;
    },
  },

  {
    name: "calendar.delete_event",
    connector: "google",
    // Cancelling notifies every attendee and cannot be undone from here.
    risk: "dangerous",
    description:
      "Cancel and delete an event. This notifies all attendees and is irreversible — prefer calendar.update_event when the user means to reschedule rather than cancel.",
    input: {
      type: "object",
      properties: {
        eventId: { type: "string" },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
    preview: (input: { eventId: string }) =>
      `Cancel event ${input.eventId} and notify all attendees. This cannot be undone.`,
    async run(input: { eventId: string }) {
      await google(`${API}/calendars/primary/events/${input.eventId}?sendUpdates=all`, {
        method: "DELETE",
      });
      return `Cancelled event ${input.eventId}.`;
    },
  },
];
