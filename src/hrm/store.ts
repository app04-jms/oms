import { useSyncExternalStore } from 'react';
import type {
  Shift,
  Department,
  WorkStatus,
  Employee,
  Schedule,
  LeaveEntry,
  HrmSettings,
  AttendanceLog,
  ApprovalRequest,
  TimesheetClosure,
  DailyBreakdownEntry,
} from './types';

// ── Storage Keys ──────────────────────────────────────────────
const K_SETTINGS = 'oms_hrm_settings';
const K_SHIFTS = 'oms_hrm_shifts';
const K_DEPARTMENTS = 'oms_hrm_departments';
const K_STATUSES = 'oms_hrm_work_statuses';
const K_EMPLOYEES = 'oms_hrm_employees';
const K_SCHEDULES = 'oms_hrm_schedules';
const K_LEAVE = 'oms_hrm_leave_ledger';
const K_ATTENDANCE = 'oms_hrm_attendance_logs';
const K_APPROVALS = 'oms_hrm_approval_requests';
const K_CLOSURES = 'oms_hrm_timesheet_closures';

// ── Default Seed Data ─────────────────────────────────────────
const DEFAULT_SETTINGS: HrmSettings = {
  hotel_lat: 10.7769,
  hotel_lng: 106.7009,
  radius_m: 200,
  window_before: 60,
  window_after: 120,
  tolerance: 10,
  monthly_leave_accrual: 1.0,
};

const DEFAULT_SHIFTS: Shift[] = [
  { id: 's1', code: 'S', name: 'Ca Sáng', start_time: '06:00', end_time: '14:00', kind: 'work', deducts_leave: false },
  { id: 's2', code: 'C', name: 'Ca Chiều', start_time: '14:00', end_time: '22:00', kind: 'work', deducts_leave: false },
  { id: 's3', code: 'D', name: 'Ca Đêm', start_time: '22:00', end_time: '06:00', kind: 'work', deducts_leave: false },
  { id: 's4', code: 'OFF', name: 'Nghỉ', start_time: '', end_time: '', kind: 'off', deducts_leave: false },
  { id: 's5', code: 'P', name: 'Phép', start_time: '', end_time: '', kind: 'off', deducts_leave: true },
];

const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'd1', name: 'Lễ tân' },
  { id: 'd2', name: 'Buồng phòng' },
  { id: 'd3', name: 'Bếp' },
  { id: 'd4', name: 'Bảo trì' },
];

const DEFAULT_STATUSES: WorkStatus[] = [
  { id: 'w1', name: 'Đang làm việc', can_schedule_and_clock: true },
  { id: 'w2', name: 'Thử việc', can_schedule_and_clock: true },
  { id: 'w3', name: 'Nghỉ phép dài', can_schedule_and_clock: false },
  { id: 'w4', name: 'Đã nghỉ việc', can_schedule_and_clock: false },
];

const DEFAULT_EMPLOYEES: Employee[] = [
  { id: 'e1', employee_code: 'NV001', display_name: 'Nguyễn Văn An', full_name: 'Nguyễn Văn An', department_id: 'd1', job_title: 'Lễ tân', phone: '0901234567', start_date: '2024-01-15', status_id: 'w1', has_leave: true, opening_leave_balance: 12, user_id: 'usr_seedstf', hotel_id: 'htl_01', base_salary: 0 },
  { id: 'e2', employee_code: 'NV002', display_name: 'Trần Thị Bình', full_name: 'Trần Thị Bình', department_id: 'd2', job_title: 'Nhân viên buồng phòng', phone: '0902345678', start_date: '2024-03-01', status_id: 'w1', has_leave: true, opening_leave_balance: 12, user_id: null, hotel_id: 'htl_01', base_salary: 0 },
  { id: 'e3', employee_code: 'NV003', display_name: 'Lê Minh Cường', full_name: 'Lê Minh Cường', department_id: 'd3', job_title: 'Bếp trưởng', phone: '0903456789', start_date: '2023-06-10', status_id: 'w1', has_leave: true, opening_leave_balance: 12, user_id: null, hotel_id: 'htl_01', base_salary: 0 },
  { id: 'e4', employee_code: 'NV004', display_name: 'Phạm Thị Dung', full_name: 'Phạm Thị Dung', department_id: 'd1', job_title: 'Trưởng ca lễ tân', phone: '0904567890', start_date: '2023-09-20', status_id: 'w1', has_leave: true, opening_leave_balance: 12, user_id: null, hotel_id: 'htl_01', base_salary: 0 },
  { id: 'e5', employee_code: 'NV005', display_name: 'Hoàng Văn Em', full_name: 'Hoàng Văn Em', department_id: 'd4', job_title: 'Kỹ thuật', phone: '0905678901', start_date: '2024-05-05', status_id: 'w2', has_leave: true, opening_leave_balance: 6, user_id: null, hotel_id: 'htl_01', base_salary: 0 },
];

// ── Generic localStorage helpers ──────────────────────────────
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // Validate: if fallback is an array, parsed must be an array too
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback;
    // Validate: if fallback is an object (not array), parsed must be a non-null object
    if (!Array.isArray(fallback) && typeof fallback === 'object' && fallback !== null && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore quota / privacy errors */ }
}

// ── Reactive store with pub/sub ───────────────────────────────
class SimpleStore<T> {
  private key: string;
  private value: T;
  private listeners = new Set<() => void>();

  constructor(key: string, initial: T) {
    this.key = key;
    this.value = load(key, initial);
    // Persist initial seed if nothing was stored
    try {
      if (localStorage.getItem(key) === null) save(key, this.value);
    } catch { /* ignore */ }
  }

  get(): T {
    return this.value;
  }

  set(updater: T | ((prev: T) => T)): void {
    this.value = typeof updater === 'function'
      ? (updater as (prev: T) => T)(this.value)
      : updater;
    save(this.key, this.value);
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): T => this.value;
}

// ── Store instances ───────────────────────────────────────────
const settingsStore = new SimpleStore<HrmSettings>(K_SETTINGS, DEFAULT_SETTINGS);
const shiftsStore = new SimpleStore<Shift[]>(K_SHIFTS, DEFAULT_SHIFTS);
const departmentsStore = new SimpleStore<Department[]>(K_DEPARTMENTS, DEFAULT_DEPARTMENTS);
const statusesStore = new SimpleStore<WorkStatus[]>(K_STATUSES, DEFAULT_STATUSES);
const employeesStore = new SimpleStore<Employee[]>(K_EMPLOYEES, DEFAULT_EMPLOYEES);

// Backfill: ensure employee 'e1' is linked to the staff user for existing
// localStorage caches that predate the user_id seed fix.
(() => {
  const current = employeesStore.get();
  const updated = current.map((e) =>
    e.id === 'e1' && !e.user_id ? { ...e, user_id: 'usr_seedstf' } : e
  );
  if (updated !== current) {
    employeesStore.set(updated);
  }
})();
const schedulesStore = new SimpleStore<Schedule[]>(K_SCHEDULES, []);
const leaveStore = new SimpleStore<LeaveEntry[]>(K_LEAVE, []);
const attendanceStore = new SimpleStore<AttendanceLog[]>(K_ATTENDANCE, []);
const approvalStore = new SimpleStore<ApprovalRequest[]>(K_APPROVALS, []);
const closuresStore = new SimpleStore<TimesheetClosure[]>(K_CLOSURES, []);

// ── Hooks ─────────────────────────────────────────────────────
export function useHrmSettings(): [HrmSettings, (updater: (prev: HrmSettings) => HrmSettings) => void] {
  const value = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot);
  const update = (updater: (prev: HrmSettings) => HrmSettings) => settingsStore.set(updater);
  return [value, update];
}

export function useShifts(): [Shift[], (updater: (prev: Shift[]) => Shift[]) => void] {
  const value = useSyncExternalStore(shiftsStore.subscribe, shiftsStore.getSnapshot);
  const update = (updater: (prev: Shift[]) => Shift[]) => shiftsStore.set(updater);
  return [value, update];
}

export function useDepartments(): [Department[], (updater: (prev: Department[]) => Department[]) => void] {
  const value = useSyncExternalStore(departmentsStore.subscribe, departmentsStore.getSnapshot);
  const update = (updater: (prev: Department[]) => Department[]) => departmentsStore.set(updater);
  return [value, update];
}

export function useWorkStatuses(): [WorkStatus[], (updater: (prev: WorkStatus[]) => WorkStatus[]) => void] {
  const value = useSyncExternalStore(statusesStore.subscribe, statusesStore.getSnapshot);
  const update = (updater: (prev: WorkStatus[]) => WorkStatus[]) => statusesStore.set(updater);
  return [value, update];
}

export function useEmployees(): [Employee[], (updater: (prev: Employee[]) => Employee[]) => void] {
  const value = useSyncExternalStore(employeesStore.subscribe, employeesStore.getSnapshot);
  const update = (updater: (prev: Employee[]) => Employee[]) => employeesStore.set(updater);
  return [value, update];
}

export function useSchedules(): [Schedule[], (updater: (prev: Schedule[]) => Schedule[]) => void] {
  const value = useSyncExternalStore(schedulesStore.subscribe, schedulesStore.getSnapshot);
  const update = (updater: (prev: Schedule[]) => Schedule[]) => schedulesStore.set(updater);
  return [value, update];
}

export function useLeaveLedger(): [LeaveEntry[], (updater: (prev: LeaveEntry[]) => LeaveEntry[]) => void] {
  const value = useSyncExternalStore(leaveStore.subscribe, leaveStore.getSnapshot);
  const update = (updater: (prev: LeaveEntry[]) => LeaveEntry[]) => leaveStore.set(updater);
  return [value, update];
}

export function useAttendanceLogs(): [AttendanceLog[], (updater: (prev: AttendanceLog[]) => AttendanceLog[]) => void] {
  const value = useSyncExternalStore(attendanceStore.subscribe, attendanceStore.getSnapshot);
  const update = (updater: (prev: AttendanceLog[]) => AttendanceLog[]) => attendanceStore.set(updater);
  return [value, update];
}

export function useApprovalRequests(): [ApprovalRequest[], (updater: (prev: ApprovalRequest[]) => ApprovalRequest[]) => void] {
  const value = useSyncExternalStore(approvalStore.subscribe, approvalStore.getSnapshot);
  const update = (updater: (prev: ApprovalRequest[]) => ApprovalRequest[]) => approvalStore.set(updater);
  return [value, update];
}

// ── Timesheet closures ──────────────────────────────────────
export function useClosures(): [TimesheetClosure[], (updater: (prev: TimesheetClosure[]) => TimesheetClosure[]) => void] {
  const value = useSyncExternalStore(closuresStore.subscribe, closuresStore.getSnapshot);
  const update = (updater: (prev: TimesheetClosure[]) => TimesheetClosure[]) => closuresStore.set(updater);
  return [value, update];
}

// ── Overtime calculation ─────────────────────────────────────
// Overtime Rule: any daily worked time beyond 10 hours is flagged as OT.
const OT_THRESHOLD_HOURS = 10;

function timeStrToMinutes(t: string | null | undefined): number {
  if (!t) return -1;
  const parts = t.split(':');
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return -1;
  return h * 60 + m;
}

/**
 * Computes worked hours from clock-in/out strings.
 * Handles overnight shifts (clock_out < clock_in) by wrapping past midnight.
 * Returns 0 if either time is missing.
 */
export function computeWorkedHours(clockIn: string | null, clockOut: string | null): number {
  const ci = timeStrToMinutes(clockIn);
  const co = timeStrToMinutes(clockOut);
  if (ci < 0 || co < 0) return 0;
  let diff = co - ci;
  if (diff < 0) diff += 1440; // overnight wrap
  return Math.round((diff / 60) * 100) / 100;
}

/**
 * Computes OT hours for a single day: max(0, worked_hours - 10).
 */
export function computeDailyOTHours(clockIn: string | null, clockOut: string | null): number {
  const worked = computeWorkedHours(clockIn, clockOut);
  const ot = Math.max(0, worked - OT_THRESHOLD_HOURS);
  return Math.round(ot * 100) / 100;
}

/**
 * Build a per-day breakdown for one employee within a date range.
 */
export function buildDailyBreakdown(
  logs: AttendanceLog[],
  employeeId: string,
  startDate: string,
  endDate: string
): DailyBreakdownEntry[] {
  const empLogs = logs
    .filter((l) => l.employee_id === employeeId && l.date >= startDate && l.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  return empLogs.map((l) => {
    const worked = computeWorkedHours(l.clock_in, l.clock_out);
    const ot = Math.max(0, worked - OT_THRESHOLD_HOURS);
    return {
      date: l.date,
      shift_id: l.shift_id,
      actual_shift_id: l.actual_shift_id,
      clock_in: l.clock_in,
      clock_out: l.clock_out,
      worked_hours: Math.round(worked * 100) / 100,
      daily_ot_hours: Math.round(ot * 100) / 100,
      has_long_shift_warning: worked > OT_THRESHOLD_HOURS,
    };
  });
}

// ── ID generator ──────────────────────────────────────────────
export function genId(prefix: string = ''): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Auto-generate employee code ───────────────────────────────
export function nextEmployeeCode(employees: Employee[]): string {
  const max = employees.reduce((m, e) => {
    const code = e?.employee_code || '';
    const n = parseInt(code.replace(/\D/g, ''), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return 'NV' + String(max + 1).padStart(3, '0');
}

// ── Leave balance calculator ──────────────────────────────────
export function getLeaveBalance(entries: LeaveEntry[], employeeId: string): number {
  return entries
    .filter((e) => e?.employee_id === employeeId)
    .reduce((sum, e) => sum + (e?.days || 0), 0);
}

// ── Helper: get employees by schedule eligibility ─────────────
export function getSchedulableEmployees(employees: Employee[], statuses: WorkStatus[]): Employee[] {
  const okStatusIds = new Set(statuses.filter((s) => s?.can_schedule_and_clock).map((s) => s.id));
  return employees.filter((e) => okStatusIds.has(e?.status_id || ''));
}
