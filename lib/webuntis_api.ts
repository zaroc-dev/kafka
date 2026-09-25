import type { UserSubject } from "@/types/subjects";
import { FieldMap, studyFieldType } from "@/types/types";
import { Lesson, SchoolYear, WebUntis } from "webuntis";

// Overwrite in .env file
const default_settings = {
  school: process.env.WEBUNTIS_SCHOOL || "HS-Albstadt",
  username: process.env.WEBUNTIS_USERNAME || "ITS1",
  password: process.env.WEBUNTIS_PASSWORD || "",
  server: process.env.WEBUNTIS_SERVER || "hs-albstadt.webuntis.com",
  useragent: process.env.WEBUNTIS_USERAGENT || "WebUntis/1.0",
};

// WebUntis listet Propädeutikum/vorlesungsfrei/Prüfungszeit als eigene
// "Schuljahre" zwischen den echten Semestern. Nur "WS 2026/2027", "SS 2026"
// oder "2025/2026" sollen als echtes Semester zählen.
const SEMESTER_NAME_REGEX = /^(?:WS\s?\d{4}\/\d{4}|SS\s?\d{4}|\d{4}\/\d{4})$/;

export class WebUntisAPI {
  public webuntis: WebUntis;
  private static instance: WebUntisAPI;
  private currentSchoolyear: SchoolYear | null = null;
  private validateSession: boolean = true;
  private dataCache: Map<string, { timestamp: number; data: any }> = new Map();
  private CACHE_TTL = 3600 * 1000; // 1 hour

  static getInstance() {
    if (!WebUntisAPI.instance) {
      WebUntisAPI.instance = new WebUntisAPI();
    }
    return WebUntisAPI.instance;
  }

  constructor(
    school: string = default_settings.school,
    username: string = default_settings.username,
    password: string = default_settings.password,
    server: string = default_settings.server,
  ) {
    this.webuntis = new WebUntis(school, username, password, server);
  }

  // login für WebUntis
  async login() {
    try {
      // Small optimization: if we have some data in cache, session might be valid
      // but let's be safe and check validateSession but maybe not every 5 seconds
      const isSessionValid = await this.webuntis.validateSession();
      if (!isSessionValid) {
        await this.webuntis.login();
        console.log("Logged in to WebUntis.");
      }
    } catch (error) {
      console.error("Login failed:", error);
    }
  }

  async logout() {
    try {
      await this.webuntis.logout();
    } catch (error) {
      console.error("Logout failed:", error);
    }
  }
  // aktuelles Semester: WebUntis' eigenes getCurrentSchoolyear() liefert
  // in den Übergangswochen (z.B. Propädeutikum) irrtümlich diese
  // Kurzperioden statt des echten Semesters. Deshalb wird stattdessen aus
  // allen Schuljahren per Namens-Regex das nächstgelegene echte Semester
  // (WS/SS) ausgewählt.
  async getCurrentSchoolYear() {
    const years = await this.getSchoolYears();
    const semesters = years.filter((y: SchoolYear) =>
      SEMESTER_NAME_REGEX.test(y.name.trim()),
    );

    if (semesters.length === 0) {
      throw new Error("No current school year found.");
    }

    const now = Date.now();
    const distanceToNow = (year: SchoolYear) => {
      const start = new Date(year.startDate).getTime();
      const end = new Date(year.endDate).getTime();
      if (now < start) return start - now;
      if (now > end) return now - end;
      return 0;
    };

    const closest = semesters.reduce((best, year) =>
      distanceToNow(year) < distanceToNow(best) ? year : best,
    );

    this.currentSchoolyear = closest;
    return closest;
  }

  async getSchoolYears(): Promise<SchoolYear[]> {
    const cacheKey = "schoolYears";
    const cached = this.dataCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const years = await this.webuntis.getSchoolyears(true);
    this.dataCache.set(cacheKey, {
      timestamp: Date.now(),
      data: years,
    });
    return years;
  }

  async getSchoolYearByName(name: string) {
    const years = await this.getSchoolYears();
    const year = years.find((y: SchoolYear) => y.name === name);
    if (!year) {
      throw new Error(`School year with name ${name} not found.`);
    }
    return year;
  }
  // Alle Fakultäten / Studiengänge
  async getDepartments() {
    return await this.webuntis.getDepartments();
  }

  async getClasses() {
    if (!this.currentSchoolyear) {
      this.currentSchoolyear = await this.getCurrentSchoolYear();
    }
    return await this.webuntis.getClasses(
      this.validateSession,
      this.currentSchoolyear.id,
    );
  }

  async getTeachers() {
    return await this.webuntis.getTeachers(this.validateSession);
  }

  async getSubjects() {
    return await this.webuntis.getSubjects(this.validateSession);
  }

  async getSubjectsFiltered(
    studyField?: studyFieldType,
    enrolledClasses?: string[],
  ) {
    if (!this.currentSchoolyear) {
      this.currentSchoolyear = await this.getCurrentSchoolYear();
    }

    const classList = await this.getClasses();
    let filteredClasses;

    if (enrolledClasses && enrolledClasses.length > 0) {
      filteredClasses = classList.filter((c) =>
        enrolledClasses.includes(c.name),
      );
    } else if (studyField && studyField !== "Other") {
      const class_key = FieldMap[studyField];
      filteredClasses = classList.filter((c) => c.name.startsWith(class_key));
    } else {
      // For now Only TI-*, ITS-*, WIN-*
      filteredClasses = classList.filter((c) =>
        ["TI", "ITS", "WIN"].some((prefix) => c.name.startsWith(prefix)),
      );
    }

    // Fetch timetables for these classes to see which subjects actually appear
    const results = await Promise.all(
      filteredClasses.map((c) =>
        this.getTimetableForClass(c.id).catch((err) => {
          console.error(
            `Failed to fetch timetable for class ${c.name} (${c.id}):`,
            err,
          );
          return [] as Lesson[];
        }),
      ),
    );

    const timetableEntries = results.flat();
    const subjectIdsInTimetable = new Set<number>();

    for (const entry of timetableEntries) {
      if (entry.su && entry.su.length > 0) {
        for (const s of entry.su) {
          subjectIdsInTimetable.add(s.id);
        }
      }
    }

    // Now fetch ALL subjects to get their full metadata (longName, colors, etc.)
    const allSubjects = await this.webuntis.getSubjects(this.validateSession);

    // Filter allSubjects by the IDs we found in the timetable
    return allSubjects
      .filter((s) => subjectIdsInTimetable.has(s.id))
      .map((s) => ({
        ...s,
        longName: s.longName || (s as any).longname || s.name,
        alternateName: s.alternateName || "",
        active: s.active ?? true,
      }));
  }

  async getRooms() {
    return await this.webuntis.getRooms(this.validateSession);
  }

  async getTimegrid() {
    return await this.webuntis.getTimegrid(this.validateSession);
  }

  async getTimetableForClass(
    classId: number,
    year: SchoolYear | null = this.currentSchoolyear,
    range?: { startDate: Date; endDate: Date },
  ) {
    if (!this.currentSchoolyear) {
      this.currentSchoolyear = await this.getCurrentSchoolYear();
    }

    if (!year) {
      year = this.currentSchoolyear;
    }

    const startDate = range?.startDate || new Date(year.startDate);
    const endDate = range?.endDate || new Date(year.endDate);

    return await this.webuntis.getTimetableForRange(
      startDate,
      endDate,
      classId,
      WebUntis.TYPES.CLASS,
    );
  }

  setCurrentSchoolyear(year: SchoolYear) {
    this.currentSchoolyear = year;
  }

  async getLessonsForRange(
    startDate: Date,
    endDate: Date,
    studyField?: studyFieldType,
    enrolledClasses?: string[],
  ) {
    const classList = await this.getClasses();
    let filteredClasses;

    if (enrolledClasses && enrolledClasses.length > 0) {
      filteredClasses = classList.filter((c) =>
        enrolledClasses.includes(c.name),
      );
    } else if (studyField && studyField !== "Other") {
      const class_key = FieldMap[studyField];
      filteredClasses = classList.filter((c) => c.name.startsWith(class_key));
    } else {
      filteredClasses = classList.filter((c) =>
        ["TI", "ITS", "WIN"].some((prefix) => c.name.startsWith(prefix)),
      );
    }

    const timetablePromises = filteredClasses.map((c) =>
      this.getTimetableForRange(startDate, endDate, c.id).catch((err) => {
        console.error(
          `Failed to fetch timetable for class ${c.name} (${c.id}):`,
          err,
        );
        return [] as Lesson[];
      }),
    );

    const results = await Promise.all(timetablePromises);
    return results.flat();
  }

  async getTimetableForRange(
    startDate: Date,
    endDate: Date,
    classId: number,
  ): Promise<Lesson[]> {
    return await this.webuntis.getTimetableForRange(
      startDate,
      endDate,
      classId,
      WebUntis.TYPES.CLASS,
    );
  }

  async getTimeTableByClasses(
    enrolledSubjects: UserSubject[],
    studyField: studyFieldType,
    enrolledClasses?: string[],
  ) {
    this.currentSchoolyear = await this.getCurrentSchoolYear();

    if (studyField === "Other") {
      return [];
    }

    const classList = await this.getClasses();
    const class_key = FieldMap[studyField];
    if (!class_key) {
      throw new Error(`Invalid study field: ${studyField}`);
    }

    let filteredClasses;
    if (enrolledClasses && enrolledClasses.length > 0) {
      // Use explicit classes if provided
      filteredClasses = classList.filter((c) =>
        enrolledClasses.includes(c.name),
      );
    } else {
      // Fallback to all classes for study field
      filteredClasses = classList.filter((c) => c.name.startsWith(class_key));
    }

    const results = await Promise.all(
      filteredClasses.map((c) =>
        this.getTimetableForClass(c.id).catch((err) => {
          console.error(
            `Failed to fetch timetable for class ${c.name} (${c.id}):`,
            err,
          );
          return [] as Lesson[];
        }),
      ),
    );
    const timetableEntries = results.flat();

    const uncompleted_subjects = enrolledSubjects.filter((s) => !s.completed);

    return timetableEntries.filter((entry) =>
      uncompleted_subjects.some((us) => us.id === entry.su[0]?.id),
    );
  }

  async getAllLessonsForSchoolYear(
    year: SchoolYear = this.currentSchoolyear!,
    studyField?: studyFieldType,
    enrolledClasses?: string[],
  ): Promise<Lesson[]> {
    if (!year) {
      year = await this.getCurrentSchoolYear();
    }

    this.setCurrentSchoolyear(year);

    // Check cache (we might need a more granular cache if we filter by field/classes,
    // but for now let's use a global one or just ignore cache if filters are present
    // or include filters in cache key)
    const cacheKey = `lessons_${year.name}_${studyField || "all"}_${(enrolledClasses || []).join(",")}`;
    const cached = this.dataCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`Using cached lessons for ${year.name}`);
      return cached.data;
    }

    const classList = await this.getClasses();

    let filteredClasses;

    if (enrolledClasses && enrolledClasses.length > 0) {
      filteredClasses = classList.filter((c) =>
        enrolledClasses.includes(c.name),
      );
    } else if (studyField && studyField !== "Other") {
      const class_key = FieldMap[studyField];
      filteredClasses = classList.filter((c) => c.name.startsWith(class_key));
    } else {
      // For now Only TI-*, ITS-*, WIN-*
      filteredClasses = classList.filter((c) =>
        ["TI", "ITS", "WIN"].some((prefix) => c.name.startsWith(prefix)),
      );
    }

    const timetablePromises = filteredClasses.map((c) =>
      this.getTimetableForClass(c.id, year).catch((err) => {
        console.error(
          `Failed to fetch timetable for class ${c.name} (${c.id}):`,
          err,
        );
        return [] as Lesson[];
      }),
    );

    const results = await Promise.all(timetablePromises);
    const timetableEntries = results.flat();

    // Store in cache
    this.dataCache.set(cacheKey, {
      timestamp: Date.now(),
      data: timetableEntries,
    });

    return timetableEntries;
  }
}

const webuntisApi = new WebUntisAPI();
await webuntisApi.login();

export { webuntisApi };
