// Live sessions + office hours. One tool, lazy like the others.
// BACKLOG: this stub is the same for every cohort. Replace fetch() with a DB read
// keyed by courseId. Do not add a per-course template file before that.
const SCHEDULE = {
  source: "stub",
  howToWatch: "Open the recording link for that session. Recordings stay up after the live hour.",
  lastSession: {
    title: "Week 2 live session",
    when: "Tue 23 Sep 2026, 10:00",
    recordingUrl: "https://example.com/recordings/week-2",
  },
  recordings: [
    { title: "Orientation", when: "Tue 9 Sep 2026, 10:00", recordingUrl: "https://example.com/recordings/orientation" },
    { title: "Week 1 live session", when: "Tue 16 Sep 2026, 10:00", recordingUrl: "https://example.com/recordings/week-1" },
    { title: "Week 2 live session", when: "Tue 23 Sep 2026, 10:00", recordingUrl: "https://example.com/recordings/week-2" },
  ],
  upcoming: [
    { kind: "live_session", title: "Week 3 live session", when: "Tue 30 Sep 2026, 10:00" },
    { kind: "office_hours", title: "Office hours", when: "Thu 2 Oct 2026, 16:00" },
  ],
};

async function fetch() {
  return { schedule: SCHEDULE };
}

const tools = [
  {
    def: {
      name: "get_live_schedule",
      description: "Live sessions and office hours for this cohort: last session, how to watch its recording, past recordings from orientation onward, and upcoming live sessions and office hours. Use for when the last session was, how to watch a recording (last or any past week), what's coming up, what if they missed one, and what if the time does not fit their work. Answer only from this result. Times are as written — do not add a timezone.",
      input_schema: { type: "object", properties: {} },
    },
    run: (_i, d) => d.schedule,
  },
];

export const livesessions = { name: "livesessions", fetch, tools };
