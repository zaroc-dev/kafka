import {
  getUserSettings,
  getEnrolledAndUncompletedSubjects,
} from "@/lib/subjects";
import { webuntisApi } from "@/lib/webuntis_api";
import ical, { ICalAlarmData, ICalAlarmType } from "ical-generator";

import { NextRequest } from "next/server";

import {
  convertWebUntisLessons,
  groupConsecutiveLessons,
  WebUntisLesson,
} from "@/lib/webuntis-utils";
import { studyFieldType } from "@/types/types";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;

  try {
    await webuntisApi.login();

    // Fetch user data
    const userSettings = await getUserSettings(userId);

    if (!userSettings) {
      return new Response("User not found", { status: 404 });
    }

    const subjects = await getEnrolledAndUncompletedSubjects(userId);
    const studyField = (userSettings.studyField as studyFieldType) || "Other";
    const enrolledClasses = userSettings.enrolledClasses || [];

    let schoolYear;
    if (userSettings.defaultSchoolYear) {
      try {
        schoolYear = await webuntisApi.getSchoolYearByName(
          userSettings.defaultSchoolYear,
        );
      } catch (error) {
        console.warn(
          `Saved school year ${userSettings.defaultSchoolYear} is unavailable; using the current school year instead.`,
          error,
        );
        schoolYear = await webuntisApi.getCurrentSchoolYear();
      }
    } else {
      schoolYear = await webuntisApi.getCurrentSchoolYear();
    }

    const allLessons = await webuntisApi.getAllLessonsForSchoolYear(
      schoolYear,
      studyField,
      enrolledClasses,
    );

    // Filter lessons by user's enrolled subjects (consistent with /api/webuntis)
    const subjectIds = new Set(subjects.map((s) => s.id));
    const uniqueLessons = new Map<number, WebUntisLesson>();

    for (const lesson of allLessons) {
      if (
        lesson.su &&
        lesson.su.some((su: { id: number }) => subjectIds.has(su.id))
      ) {
        uniqueLessons.set(lesson.id, lesson as WebUntisLesson);
      }
    }

    const parsedEvents = convertWebUntisLessons(
      Array.from(uniqueLessons.values()),
    );
    const groupedEvents = groupConsecutiveLessons(parsedEvents);

    const calendar = ical({
      name: `Kafka - ${userSettings.displayName || "User"}`,
      timezone: "Europe/Berlin",
    });

    let userAlerts = {
      alarmsEnabled: userSettings.alarmsEnabled ?? false,
      multiAlarmEnabled: userSettings.multiAlarmEnabled ?? false,
      alarmTime: userSettings.alarmTime ?? 15,
      multiAlerts: userSettings.multiAlerts || [],
    };

    let alerts: ICalAlarmData[] = [];

    if (userAlerts.alarmsEnabled) {
      if (userAlerts.multiAlarmEnabled && userAlerts.multiAlerts.length > 0) {
        alerts = userAlerts.multiAlerts.map((time: number) => ({
          type: ICalAlarmType.display,
          trigger: time * 60,
        }));
      } else if (userAlerts.alarmTime) {
        alerts = [
          {
            type: ICalAlarmType.display,
            trigger: userAlerts.alarmTime * 60,
          },
        ];
      }
    }

    groupedEvents.forEach((event) => {
      const summary = event.isCancelled
        ? `AUSFALL: ${event.title}`
        : event.title;
      const description = [
        `Dozent: ${event.professor || "N/A"}`,
        `Fach: ${event.title}`,
        event.isCancelled
          ? "\n--- ACHTUNG ---\nDIESE VORLESUNG FÄLLT AUS!"
          : null,
      ]
        .filter(Boolean)
        .join("\n");

      calendar.createEvent({
        start: new Date(event.startTime),
        end: new Date(event.endTime),
        summary: event.isCancelled ? `AUSFALL: ${event.title}` : event.title,
        description,
        location: event.isCancelled
          ? `ENTFÄLLT (ursprünglich: ${event.location})`
          : event.location,
        alarms: event.isCancelled ? [] : alerts,
      });
    });

    const calendarData = calendar.toString();

    return new Response(calendarData, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="calendar_${userId}.ics"`,
      },
    });
  } catch (error) {
    console.error("Error generating calendar:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
