import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserSettings: vi.fn(),
  getEnrolledAndUncompletedSubjects: vi.fn(),
  login: vi.fn(),
  getCurrentSchoolYear: vi.fn(),
  getSchoolYearByName: vi.fn(),
  getAllLessonsForSchoolYear: vi.fn(),
}));

vi.mock("@/lib/subjects", () => ({
  getUserSettings: mocks.getUserSettings,
  getEnrolledAndUncompletedSubjects:
    mocks.getEnrolledAndUncompletedSubjects,
}));

vi.mock("@/lib/webuntis_api", () => ({
  webuntisApi: {
    login: mocks.login,
    getCurrentSchoolYear: mocks.getCurrentSchoolYear,
    getSchoolYearByName: mocks.getSchoolYearByName,
    getAllLessonsForSchoolYear: mocks.getAllLessonsForSchoolYear,
  },
}));

import { GET } from "@/app/api/calendar/[userId]/route";

const userId = "test-user";
const selectedSchoolYear = {
  id: 134,
  name: "WS 2026/2027",
  startDate: new Date("2026-09-28T00:00:00.000Z"),
  endDate: new Date("2027-01-23T00:00:00.000Z"),
};
const lesson = {
  id: 631065,
  date: 20260929,
  startTime: 945,
  endTime: 1115,
  kl: [{ id: 6454, name: "TI-3", longname: "TI-3" }],
  te: [{ id: 180, name: "StauBe", longname: "Stauss" }],
  su: [
    {
      id: 3167,
      name: "EinfProzMod",
      longname: "Einführung in die Prozessmodellierung",
    },
  ],
  ro: [{ id: 3, name: "201-007", longname: "Vorlesungsraum" }],
  activityType: "Unterricht",
};

async function generateCalendar() {
  return GET({} as never, { params: Promise.resolve({ userId }) });
}

describe("calendar ICS route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserSettings.mockResolvedValue({
      displayName: "Test User",
      studyField: "Technische Informatik",
      enrolledClasses: ["TI-3"],
      defaultSchoolYear: selectedSchoolYear.name,
    });
    mocks.getEnrolledAndUncompletedSubjects.mockResolvedValue([
      { id: 3167, completed: false },
    ]);
    mocks.getSchoolYearByName.mockResolvedValue(selectedSchoolYear);
    mocks.getCurrentSchoolYear.mockResolvedValue(selectedSchoolYear);
    mocks.getAllLessonsForSchoolYear.mockResolvedValue([lesson]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses the user's saved school year and generates events", async () => {
    const response = await generateCalendar();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(mocks.getSchoolYearByName).toHaveBeenCalledWith("WS 2026/2027");
    expect(mocks.getCurrentSchoolYear).not.toHaveBeenCalled();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain("SUMMARY:Einführung in die Prozessmodellierung");
    expect(body).toContain("END:VCALENDAR");
  });

  test("falls back to the current school year when no saved year exists", async () => {
    mocks.getUserSettings.mockResolvedValue({
      displayName: "Test User",
      studyField: "Technische Informatik",
      enrolledClasses: ["TI-3"],
    });

    const response = await generateCalendar();

    expect(response.status).toBe(200);
    expect(mocks.getCurrentSchoolYear).toHaveBeenCalledOnce();
    expect(mocks.getSchoolYearByName).not.toHaveBeenCalled();
  });

  test("falls back when the saved school year is no longer available", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getSchoolYearByName.mockRejectedValue(new Error("Year not found"));

    const response = await generateCalendar();

    expect(response.status).toBe(200);
    expect(mocks.getCurrentSchoolYear).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  test("deduplicates lessons returned for multiple enrolled classes", async () => {
    mocks.getAllLessonsForSchoolYear.mockResolvedValue([lesson, { ...lesson }]);

    const response = await generateCalendar();
    const body = await response.text();

    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});
