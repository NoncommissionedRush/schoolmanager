// Static fixtures for the demo school. Times are minutes since midnight in the
// school's timezone; weekdays are ISO (1 = Monday … 7 = Sunday).

const h = (hours: number, minutes = 0) => hours * 60 + minutes;

export const SCHOOL = {
  name: "Demo Language School",
  timezone: "Europe/Bratislava",
};

export const EMAIL_DOMAIN = "demo-school.test";

/** Lessons before this date are seeded as COMPLETED, later ones SCHEDULED. */
export const DEMO_TODAY = "2026-10-14";

export const ADMIN = { key: "admin", name: "Alexandra Admin" };

/**
 * Password of every seeded user (documented in the README). Demo only — never
 * seed a real deployment with it.
 */
export const DEMO_PASSWORD = "demo-password";

/** One sign-in per role, shown on the dev login page and used by e2e tests. */
export const DEMO_LOGINS = {
  admin: "admin@demo-school.test",
  teacher: "jana.novakova@demo-school.test",
  student: "adam.kollar@demo-school.test",
} as const;

export const LEVELS = [
  { code: "A1", name: "Beginner", rank: 1 },
  { code: "A2", name: "Elementary", rank: 2 },
  { code: "B1", name: "Intermediate", rank: 3 },
  { code: "B2", name: "Upper intermediate", rank: 4 },
  { code: "C1", name: "Advanced", rank: 5 },
] as const;

export type LevelCode = (typeof LEVELS)[number]["code"];

/** No longer offered: hidden from pickers, has no courses or groups. */
export const ARCHIVED_LEVELS = [
  { code: "C2", name: "Proficiency", rank: 6 },
] as const;

export const COURSES: { key: string; name: string; level: LevelCode }[] = [
  ...LEVELS.map((l) => ({
    key: `general-${l.code.toLowerCase()}`,
    name: `General English ${l.code}`,
    level: l.code,
  })),
  { key: "business-b2", name: "Business English B2", level: "B2" },
];

// Colours are the admin form's swatch palette (TEACHER_COLORS in
// src/server/admin/people/schema.ts).
export const TEACHERS = [
  { key: "t-novak", name: "Jana Nováková", color: "#2563eb" },
  { key: "t-smith", name: "Oliver Smith", color: "#16a34a" },
  { key: "t-horvath", name: "Peter Horváth", color: "#ea580c" },
  { key: "t-kovac", name: "Lucia Kováčová", color: "#e11d48" },
  { key: "t-brown", name: "Emily Brown", color: "#7c3aed" },
  { key: "t-varga", name: "Martin Varga", color: "#0d9488" },
  { key: "t-oconnor", name: "Siobhan O'Connor", color: "#b45309" },
  { key: "t-tothova", name: "Eva Tóthová", color: "#475569" },
] as const;

export type TeacherKey = (typeof TEACHERS)[number]["key"];

export const TEACHER_AVAILABILITY: {
  key: string;
  teacher: TeacherKey;
  kind: "WEEKLY_UNAVAILABLE" | "DATE_UNAVAILABLE" | "DATE_AVAILABLE";
  weekday?: number;
  date?: string;
  startMinute?: number;
  endMinute?: number;
  note: string;
}[] = [
  {
    key: "novak-fri",
    teacher: "t-novak",
    kind: "WEEKLY_UNAVAILABLE",
    weekday: 5,
    startMinute: 0,
    endMinute: h(24),
    note: "Part-time, no Fridays",
  },
  {
    key: "horvath-mon-am",
    teacher: "t-horvath",
    kind: "WEEKLY_UNAVAILABLE",
    weekday: 1,
    startMinute: h(8),
    endMinute: h(12),
    note: "University lectures",
  },
  {
    key: "brown-wed",
    teacher: "t-brown",
    kind: "WEEKLY_UNAVAILABLE",
    weekday: 3,
    startMinute: 0,
    endMinute: h(24),
    note: "Works elsewhere on Wednesdays",
  },
  {
    key: "brown-wed-exception",
    teacher: "t-brown",
    kind: "DATE_AVAILABLE",
    date: "2026-11-04",
    note: "Can cover this Wednesday",
  },
  {
    key: "kovac-conference",
    teacher: "t-kovac",
    kind: "DATE_UNAVAILABLE",
    date: "2026-10-21",
    note: "Teacher training conference",
  },
  {
    key: "varga-doctor",
    teacher: "t-varga",
    kind: "DATE_UNAVAILABLE",
    date: "2026-10-27",
    startMinute: h(8),
    endMinute: h(12),
    note: "Doctor's appointment",
  },
];

export const ROOMS = [
  {
    key: "room-1",
    name: "Room 1 (London)",
    kind: "PHYSICAL",
    capacity: 10,
    meetingUrl: null,
  },
  {
    key: "room-2",
    name: "Room 2 (Dublin)",
    kind: "PHYSICAL",
    capacity: 8,
    meetingUrl: null,
  },
  {
    key: "room-3",
    name: "Room 3 (Edinburgh)",
    kind: "PHYSICAL",
    capacity: 8,
    meetingUrl: null,
  },
  {
    key: "room-4",
    name: "Room 4 (Small)",
    kind: "PHYSICAL",
    capacity: 3,
    meetingUrl: null,
  },
  {
    key: "online",
    name: "Online classroom",
    kind: "ONLINE",
    capacity: null,
    meetingUrl: "https://meet.example.com/demo-school",
  },
] as const;

export type RoomKey = (typeof ROOMS)[number]["key"];

/** Closed rooms: hidden from pickers, no slots may be added to them. */
export const ARCHIVED_ROOMS = [
  {
    key: "room-5",
    name: "Room 5 (Old annex)",
    kind: "PHYSICAL",
    capacity: 6,
    meetingUrl: null,
  },
] as const;

/** When the archived levels and rooms were archived. */
export const ARCHIVED_AT = new Date("2026-06-30T00:00:00Z");

export const TERM = {
  key: "autumn-2026",
  name: "Autumn 2026",
  startDate: "2026-09-14",
  endDate: "2027-01-29",
};

/** Lessons are generated for the first weeks only (covers DEMO_TODAY). */
export const LESSON_GENERATION_END = "2026-11-08";

export const HOLIDAYS: {
  key: string;
  name: string;
  startDate: string;
  endDate: string;
  schoolWide?: boolean;
}[] = [
  {
    key: "autumn-break",
    name: "Autumn break",
    startDate: "2026-10-29",
    endDate: "2026-10-30",
  },
  {
    // Public holiday: school-wide (`termId` null), applies to every term.
    key: "nov-17",
    schoolWide: true,
    name: "Struggle for Freedom and Democracy Day",
    startDate: "2026-11-17",
    endDate: "2026-11-17",
  },
  {
    key: "christmas",
    name: "Christmas break",
    startDate: "2026-12-21",
    endDate: "2027-01-06",
  },
];

type SlotSpec = {
  weekday: number;
  start: number;
  end: number;
  /** Slot lifecycle (docs/architecture/scheduling.md); omitted = whole term. */
  validFrom?: string;
  validUntil?: string;
};
const twice = (days: [number, number], start: number): SlotSpec[] =>
  days.map((weekday) => ({ weekday, start, end: start + 90 }));

export type GroupSpec = {
  key: string;
  name: string;
  type: "GROUP" | "ONE_ON_ONE";
  level: LevelCode;
  course: string;
  capacity: number;
  teacher: TeacherKey;
  room: RoomKey;
  slots: SlotSpec[];
};

export const GROUPS: GroupSpec[] = [
  {
    key: "a1-morning",
    name: "A1 Morning",
    type: "GROUP",
    level: "A1",
    course: "general-a1",
    capacity: 8,
    teacher: "t-novak",
    room: "room-1",
    slots: twice([1, 3], h(9)),
  },
  {
    key: "a1-evening",
    name: "A1 Evening",
    type: "GROUP",
    level: "A1",
    course: "general-a1",
    capacity: 8,
    teacher: "t-smith",
    room: "room-1",
    slots: twice([1, 3], h(17)),
  },
  {
    key: "a2-morning",
    name: "A2 Morning",
    type: "GROUP",
    level: "A2",
    course: "general-a2",
    capacity: 8,
    teacher: "t-horvath",
    room: "room-2",
    // Mid-term change: the Thursday lesson moves to Friday from 26 October.
    // The Thursday slot ends (its earlier lessons stay) and a Friday slot
    // continues, exactly as the timetable editor records such an edit.
    slots: [
      { weekday: 2, start: h(9), end: h(10, 30) },
      { weekday: 4, start: h(9), end: h(10, 30), validUntil: "2026-10-25" },
      { weekday: 5, start: h(9), end: h(10, 30), validFrom: "2026-10-26" },
    ],
  },
  {
    key: "a2-evening",
    name: "A2 Evening",
    type: "GROUP",
    level: "A2",
    course: "general-a2",
    capacity: 8,
    teacher: "t-novak",
    room: "room-2",
    slots: twice([1, 3], h(17)),
  },
  {
    key: "b1-evening",
    name: "B1 Evening",
    type: "GROUP",
    level: "B1",
    course: "general-b1",
    capacity: 8,
    teacher: "t-kovac",
    room: "room-3",
    slots: twice([1, 3], h(18, 45)),
  },
  {
    key: "b1-online",
    name: "B1 Online",
    type: "GROUP",
    level: "B1",
    course: "general-b1",
    capacity: 10,
    teacher: "t-brown",
    room: "online",
    slots: twice([2, 4], h(18, 45)),
  },
  {
    key: "b2-evening",
    name: "B2 Evening",
    type: "GROUP",
    level: "B2",
    course: "general-b2",
    capacity: 8,
    teacher: "t-varga",
    room: "room-3",
    slots: twice([2, 4], h(17)),
  },
  {
    key: "b2-late",
    name: "B2 Late",
    type: "GROUP",
    level: "B2",
    course: "general-b2",
    capacity: 8,
    teacher: "t-oconnor",
    room: "room-1",
    slots: twice([2, 4], h(18, 45)),
  },
  {
    key: "b2-business",
    name: "Business English B2",
    type: "GROUP",
    level: "B2",
    course: "business-b2",
    capacity: 6,
    teacher: "t-varga",
    room: "room-4",
    slots: twice([1, 3], h(17)),
  },
  {
    key: "c1-evening",
    name: "C1 Evening",
    type: "GROUP",
    level: "C1",
    course: "general-c1",
    capacity: 8,
    teacher: "t-tothova",
    room: "room-2",
    slots: twice([1, 3], h(18, 45)),
  },
  {
    key: "1on1-b1",
    name: "1-on-1 Tomáš Baláž",
    type: "ONE_ON_ONE",
    level: "B1",
    course: "general-b1",
    capacity: 1,
    teacher: "t-smith",
    room: "room-4",
    slots: [{ weekday: 5, start: h(10), end: h(11) }],
  },
  {
    key: "1on1-a2",
    name: "1-on-1 Zuzana Krajčí",
    type: "ONE_ON_ONE",
    level: "A2",
    course: "general-a2",
    capacity: 1,
    teacher: "t-oconnor",
    room: "room-4",
    slots: [{ weekday: 5, start: h(11, 15), end: h(12, 15) }],
  },
  {
    key: "1on1-c1",
    name: "1-on-1 Daniel Šimko",
    type: "ONE_ON_ONE",
    level: "C1",
    course: "general-c1",
    capacity: 1,
    teacher: "t-tothova",
    room: "online",
    slots: [{ weekday: 5, start: h(16), end: h(17) }],
  },
];

/** 40 students; `oneOnOne` students attend only their 1-on-1 group. */
export const STUDENTS: { name: string; level: LevelCode; oneOnOne?: string }[] =
  [
    // A1 (8)
    { name: "Adam Kollár", level: "A1" },
    { name: "Barbora Hudáková", level: "A1" },
    { name: "Cyril Marko", level: "A1" },
    { name: "Dominika Šulcová", level: "A1" },
    { name: "Erik Polák", level: "A1" },
    { name: "Filip Novotný", level: "A1" },
    { name: "Gabriela Lukáčová", level: "A1" },
    { name: "Hana Bartošová", level: "A1" },
    // A2 (8)
    { name: "Igor Benko", level: "A2" },
    { name: "Ivana Mináriková", level: "A2" },
    { name: "Jakub Hlaváč", level: "A2" },
    { name: "Katarína Molnárová", level: "A2" },
    { name: "Ladislav Kučera", level: "A2" },
    { name: "Monika Rybárová", level: "A2" },
    { name: "Norbert Fekete", level: "A2" },
    { name: "Zuzana Krajčí", level: "A2", oneOnOne: "1on1-a2" },
    // B1 (8)
    { name: "Ondrej Mikuš", level: "B1" },
    { name: "Petra Vlčková", level: "B1" },
    { name: "Radoslav Čech", level: "B1" },
    { name: "Simona Bieliková", level: "B1" },
    { name: "Štefan Lipták", level: "B1" },
    { name: "Tatiana Holubová", level: "B1" },
    { name: "Viktória Urbanová", level: "B1" },
    { name: "Tomáš Baláž", level: "B1", oneOnOne: "1on1-b1" },
    // B2 (10)
    { name: "Andrea Kráľová", level: "B2" },
    { name: "Boris Ďurica", level: "B2" },
    { name: "Denisa Pavlíková", level: "B2" },
    { name: "Juraj Sedlák", level: "B2" },
    { name: "Kristína Mrázová", level: "B2" },
    { name: "Lukáš Gajdoš", level: "B2" },
    { name: "Michaela Ševčíková", level: "B2" },
    { name: "Patrik Kováčik", level: "B2" },
    { name: "Renáta Čierna", level: "B2" },
    { name: "Samuel Oravec", level: "B2" },
    // C1 (6)
    { name: "Alžbeta Hrušková", level: "C1" },
    { name: "Branislav Tóth", level: "C1" },
    { name: "Elena Jurčová", level: "C1" },
    { name: "Matej Kopecký", level: "C1" },
    { name: "Natália Šoltésová", level: "C1" },
    { name: "Daniel Šimko", level: "C1", oneOnOne: "1on1-c1" },
  ];

export const LESSON_LOG_TOPICS = [
  "Present simple vs. present continuous; speaking: daily routines.",
  "Vocabulary: travel and transport; listening exercise p. 24.",
  "Past simple irregular verbs; short story writing in pairs.",
  "Reading: 'A day in London'; comprehension questions and discussion.",
  "Modal verbs for advice (should, ought to); role-play at the doctor's.",
  "Revision of unit 2; mini quiz and error correction.",
];
