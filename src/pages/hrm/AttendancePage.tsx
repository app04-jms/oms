import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  useAttendanceLogs,
  useApprovalRequests,
  useSchedules,
  useShifts,
  useEmployees,
  useHrmSettings,
  genId,
} from '@/hrm/store';
import { useHrmPermission } from '@/hrm/usePermission';
import { useTenantScope } from '@/hrm/useTenantScope';
import { useAuth } from '@/auth/AuthContext';
import { useMappings } from '@/store/authStore';
import type { AttendanceLog, ApprovalRequest, Shift } from '@/hrm/types';
import { Button, Badge, TextInput, Field, Select } from '@/components/ui';
import {
  Clock,
  LogIn,
  LogOut,
  MapPin,
  AlertTriangle,
  CheckCircle2,
  CalendarClock,
  Lock,
  UserCog,
} from 'lucide-react';
import ExportDropdown from '@/components/ExportDropdown';
import { exportToPdf } from '@/utils/pdf';
import { localDateStr } from '@/hrm/dateUtils';

function todayStr(): string {
  return localDateStr();
}

function nowHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function timeToMinutes(t: string | null | undefined): number {
  if (!t) return -1;
  const parts = t.split(':');
  if (parts.length < 2) return -1;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return -1;
  return h * 60 + m;
}

// Auto-detect the nearest work shift based on clock-in time.
// Handles overnight shifts (e.g. 22:00-06:00) by computing distance
// from the clock-in minute to the shift's start time, wrapping around midnight.
function getNearestShiftByTime(clockInTime: string, shifts: Shift[]): Shift | null {
  const now = timeToMinutes(clockInTime);
  if (now < 0) return null;
  const workShifts = shifts.filter((s) => s.kind === 'work');
  if (workShifts.length === 0) return null;

  let best: Shift | null = null;
  let bestDist = Infinity;

  for (const s of workShifts) {
    const start = timeToMinutes(s.start_time);
    if (start < 0) continue;
    // Distance from clock-in to shift start, wrapping around 24h
    let dist = Math.abs(now - start);
    if (dist > 720) dist = 1440 - dist; // wrap around midnight
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

export default function AttendancePage() {
  // ── TOP-LEVEL SAFE INITIALIZATION (avoid temporal dead zone) ──
  const { user: currentUser, session } = useAuth();
  const today = todayStr();

  const [logs, setLogs] = useAttendanceLogs();
  const [approvals, setApprovals] = useApprovalRequests();
  const [schedules] = useSchedules();
  const [shifts] = useShifts();
  const [employees] = useEmployees();
  const [settings] = useHrmSettings();
  const [mappings] = useMappings();
  const { getLevel, LEVEL_RANK } = useHrmPermission();
  const { tenantEmployeeIds, isSuperAdmin } = useTenantScope();
  const attLevel = getLevel('hrm_attendance');
  const [selectedEmpId, setSelectedEmpId] = useState<string>('');

  // ── STRICT PERMISSION RESOLUTION ──
  // Resolve the user's role within the active hotel (roles live on UserHotelAccess,
  // not on the User record itself).
  const userRoleForHotel = useMemo(() => {
    if (!currentUser || !session?.activeHotelId) return null;
    return (
      mappings.find(
        (m) => m.user_id === currentUser.id && m.hotel_id === session.activeHotelId,
      )?.role ?? null
    );
  }, [mappings, currentUser, session]);

  // Admin = can see/act on attendance for any employee.
  // Maps the spec's conceptual 'manage'/'all' levels onto the real permission
  // ladder: view_all and above, plus the hotel_admin role, plus super admins.
  const isAdmin = !!(
    currentUser?.is_super_admin ||
    userRoleForHotel === 'hotel_admin' ||
    LEVEL_RANK[attLevel] >= LEVEL_RANK.view_all
  );

  // The current user's linked employee id (falls back to user id when unlinked).
  const myEmpId = currentUser?.employee_id || currentUser?.id || '';

  // Resolve current user's linked employee: match employee.user_id === user.id,
  // or fall back to employee.id === user.employee_id, then employee_code === username.
  // Always restrict the candidate pool to the active hotel's employees.
  const myEmployee = useMemo(() => {
    if (!currentUser) return null;
    const pool = isSuperAdmin ? employees : employees.filter((e) => tenantEmployeeIds.has(e.id));
    return pool.find((e) => e.user_id === currentUser.id)
      ?? (currentUser.employee_id ? pool.find((e) => e.id === currentUser.employee_id) : null)
      ?? pool.find((e) => e.employee_code === currentUser.username)
      ?? null;
  }, [employees, currentUser, isSuperAdmin, tenantEmployeeIds]);

  // Scope: admins see all employees in the active hotel; non-admins are
  // locked to their own record only.
  const scopedEmployees = useMemo(() => {
    if (attLevel === 'hidden') return [];
    const tenantPool = isSuperAdmin ? employees : employees.filter((e) => tenantEmployeeIds.has(e.id));
    if (!isAdmin) {
      return myEmployee ? [myEmployee] : [];
    }
    return tenantPool;
  }, [employees, attLevel, isAdmin, myEmployee, isSuperAdmin, tenantEmployeeIds]);

  // Whether the current user can clock in/out (requires at least 'update')
  const canClock = LEVEL_RANK[attLevel] >= LEVEL_RANK.update;

  const [gpsStatus, setGpsStatus] = useState<{
    loading: boolean;
    distance: number | null;
    inRadius: boolean | null;
    lat: number | null;
    lng: number | null;
    error: string | null;
  }>({ loading: false, distance: null, inRadius: null, lat: null, lng: null, error: null });

  const [showMismatchModal, setShowMismatchModal] = useState(false);
  const [mismatchReason, setMismatchReason] = useState('');
  const [adjustedShiftId, setAdjustedShiftId] = useState<string>('');
  const [clockAction, setClockAction] = useState<'in' | 'out'>('in');
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // ── HARD DATA FILTERING (store & UI level) ──
  // First enforce multi-tenant isolation: logs only belong to employees in the
  // active hotel (super admin in all-hotels mode sees every employee).
  const tenantLogs = useMemo(
    () => (isSuperAdmin ? logs : logs.filter((l) => tenantEmployeeIds.has(l.employee_id))),
    [logs, isSuperAdmin, tenantEmployeeIds]
  );
  // Non-admins may only ever see attendance rows that belong to their own
  // linked employee record(s). Admins see the full tenant-scoped list.
  const visibleLogs = useMemo(() => {
    if (isAdmin) return tenantLogs;
    const myEmpIds = new Set(
      employees
        .filter((e) => e.user_id === currentUser?.id || e.id === myEmpId)
        .map((e) => e.id),
    );
    if (myEmpIds.size === 0 && myEmpId) myEmpIds.add(myEmpId);
    return tenantLogs.filter((log) => myEmpIds.has(log.employee_id));
  }, [tenantLogs, isAdmin, myEmpId, currentUser, employees]);

  // The effective employee id used for any clock/adjustment action.
  // Non-admins are ALWAYS bound to their own employee; admins use the selector.
  const effectiveEmpId = isAdmin ? selectedEmpId : (myEmployee?.id ?? myEmpId);

  // Auto-select: admins default to first available employee; non-admins are
  // force-locked to their own employee record.
  useEffect(() => {
    if (isAdmin) {
      if (scopedEmployees.length === 0) return;
      if (!scopedEmployees.some((e) => e.id === selectedEmpId)) {
        setSelectedEmpId(scopedEmployees[0].id);
      }
    } else {
      const lockedId = myEmployee?.id ?? myEmpId;
      if (lockedId && selectedEmpId !== lockedId) {
        setSelectedEmpId(lockedId);
      }
    }
  }, [isAdmin, scopedEmployees, selectedEmpId, myEmployee, myEmpId]);

  const emp = useMemo(
    () => scopedEmployees.find((e) => e.id === effectiveEmpId),
    [scopedEmployees, effectiveEmpId]
  );

  // Today's scheduled shift for this employee
  const todaySchedule = useMemo(
    () => schedules.find((s) => s.employee_id === effectiveEmpId && s.work_date === today),
    [schedules, effectiveEmpId, today]
  );

  const scheduledShift = useMemo<Shift | null>(() => {
    if (!todaySchedule) return null;
    return shifts.find((s) => s.id === todaySchedule.shift_id) ?? null;
  }, [todaySchedule, shifts]);

  // Today's attendance log for this employee (sourced from the filtered set)
  const todayLog = useMemo(
    () => visibleLogs.find((l) => l.employee_id === effectiveEmpId && l.date === today),
    [visibleLogs, effectiveEmpId, today]
  );

  // GPS check
  const checkGPS = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus({ loading: false, distance: null, inRadius: null, lat: null, lng: null, error: 'Trình duyệt không hỗ trợ GPS' });
      return;
    }
    setGpsStatus((prev) => ({ ...prev, loading: true, error: null }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, settings.hotel_lat, settings.hotel_lng);
        const inside = dist <= settings.radius_m;
        setGpsStatus({ loading: false, distance: dist, inRadius: inside, lat: pos.coords.latitude, lng: pos.coords.longitude, error: null });
      },
      (err) => {
        setGpsStatus({ loading: false, distance: null, inRadius: null, lat: null, lng: null, error: err.message || 'Không lấy được vị trí' });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, [settings.hotel_lat, settings.hotel_lng, settings.radius_m]);

  useEffect(() => {
    checkGPS();
  }, [checkGPS]);

  // Determine if clock-in matches scheduled shift
  const checkShiftMatch = (clockTime: string): boolean => {
    if (!scheduledShift || scheduledShift.kind === 'off') return false;
    const now = timeToMinutes(clockTime);
    const start = timeToMinutes(scheduledShift.start_time);
    if (start < 0 || now < 0) return false;
    const earliest = start - settings.window_before;
    const latest = start + settings.window_after;
    return now >= earliest && now <= latest;
  };

  const handleClockIn = () => {
    // Non-admins are always bound to their own employee.
    const empId = isAdmin ? selectedEmpId : effectiveEmpId;
    if (!empId) return;
    const time = nowHHmm();
    const matches = checkShiftMatch(time);

    if (matches) {
      // Direct valid clock-in
      const log: AttendanceLog = {
        id: genId('att_'),
        employee_id: empId,
        date: today,
        shift_id: todaySchedule?.shift_id ?? null,
        actual_shift_id: todaySchedule?.shift_id ?? null,
        clock_in: time,
        clock_out: null,
        lat: gpsStatus.lat,
        lng: gpsStatus.lng,
        is_outside_radius: gpsStatus.inRadius === false,
        status: gpsStatus.inRadius === false ? 'pending_approval' : 'valid',
        mismatch_reason: gpsStatus.inRadius === false ? 'Ngoài bán kính GPS' : '',
        admin_note: '',
      };
      setLogs((prev) => [...prev.filter((l) => !(l.employee_id === empId && l.date === today)), log]);
      setToast({ ok: true, msg: 'Đã ghi nhận giờ vào ca thành công.' });
    } else {
      setClockAction('in');
      setMismatchReason('');
      const detected = getNearestShiftByTime(time, shifts);
      setAdjustedShiftId(detected?.id ?? '');
      setShowMismatchModal(true);
    }
  };

  const handleClockOut = () => {
    if (!todayLog || !todayLog.clock_in) {
      setToast({ ok: false, msg: 'Bạn chưa chấm công vào ca hôm nay.' });
      return;
    }
    const time = nowHHmm();
    setLogs((prev) =>
      prev.map((l) =>
        l.id === todayLog.id ? { ...l, clock_out: time } : l
      )
    );
    setToast({ ok: true, msg: 'Đã ghi nhận giờ ra ca thành công.' });
  };

  const submitMismatch = () => {
    const empId = isAdmin ? selectedEmpId : effectiveEmpId;
    if (!mismatchReason.trim() || !empId || !adjustedShiftId) return;
    const time = nowHHmm();
    const log: AttendanceLog = {
      id: genId('att_'),
      employee_id: empId,
      date: today,
      shift_id: todaySchedule?.shift_id ?? null,
      actual_shift_id: adjustedShiftId,
      clock_in: clockAction === 'in' ? time : null,
      clock_out: clockAction === 'out' ? time : null,
      lat: gpsStatus.lat,
      lng: gpsStatus.lng,
      is_outside_radius: gpsStatus.inRadius === false,
      status: 'pending_approval',
      mismatch_reason: mismatchReason.trim(),
      admin_note: '',
    };
    setLogs((prev) => [...prev.filter((l) => !(l.employee_id === empId && l.date === today)), log]);

    const req: ApprovalRequest = {
      id: genId('apr_'),
      attendance_id: log.id,
      employee_id: empId,
      request_type: 'shift_mismatch',
      requested_shift_id: todaySchedule?.shift_id ?? null,
      adjusted_shift_id: adjustedShiftId,
      reason: mismatchReason.trim(),
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
    };
    setApprovals((prev) => [...prev, req]);

    setShowMismatchModal(false);
    setMismatchReason('');
    setAdjustedShiftId('');
    setToast({ ok: true, msg: 'Đã gửi yêu cầu điều chỉnh chấm công. Chờ quản lý phê duyệt.' });
  };

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  // Today's approval request (if any) for the adjusted shift display
  const todayApproval = useMemo(
    () => approvals.find((a) => a.attendance_id === todayLog?.id),
    [approvals, todayLog]
  );

  const adjustedShift = useMemo<Shift | null>(() => {
    const id = todayLog?.actual_shift_id ?? todayApproval?.adjusted_shift_id;
    if (!id) return null;
    return shifts.find((s) => s.id === id) ?? null;
  }, [todayLog, todayApproval, shifts]);

  const exportAttendancePdf = () => {
    const columns = [
      { label: 'Ngày' },
      { label: 'Nhân viên' },
      { label: 'Ca lịch trình' },
      { label: 'Giờ vào', width: '60px' },
      { label: 'Giờ ra', width: '60px' },
      { label: 'Trạng thái' },
    ];
    const dayLogs = visibleLogs.filter((l) => l.date === today);
    const rows = dayLogs.map((l) => {
      const emp = scopedEmployees.find((e) => e.id === l.employee_id);
      const sch = shifts.find((s) => s.id === l.shift_id);
      const statusLabel = l.status === 'valid' ? 'Đúng ca' : l.status === 'pending_approval' ? 'Chờ duyệt' : 'Từ chối';
      return [
        l.date,
        emp ? `${emp.display_name} (${emp.employee_code})` : '—',
        sch ? `${(sch.code || '').toUpperCase()} · ${sch.name}` : '—',
        l.clock_in || '—',
        l.clock_out || '—',
        statusLabel,
      ];
    });
    exportToPdf({
      title: 'Chấm công hôm nay',
      subtitle: `Ngày ${today} · ${dayLogs.length} bản ghi`,
      columns,
      rows,
      fileName: `Cham_cong_${today}.pdf`,
    });
  };

  return (
    <div className="px-8 pt-6 pb-8">
      {/* Breadcrumb */}
      <div className="mb-6">
        <nav className="flex items-center gap-1.5 text-xs font-medium text-info mb-2">
          <span>HRM</span>
          <span className="text-line">›</span>
          <span className="text-ink">Chấm công</span>
        </nav>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Clock className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-ink leading-tight">Chấm công</h1>
            <p className="text-sm text-info mt-0.5">Ghi nhận thời gian vào/ra của nhân viên theo ca.</p>
          </div>
          <ExportDropdown options={[
            { key: 'pdf', label: 'Xuất PDF (.pdf)', icon: 'pdf', onClick: exportAttendancePdf },
          ]} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Employee selector + scheduled shift info */}
        <div className="lg:col-span-1 space-y-4">
          {/* Employee selector — admin only. Non-admins see a read-only badge. */}
          <div className="bg-card rounded-xl border border-line/30 p-5">
            {isAdmin ? (
              <>
                <Field label="Nhân viên chấm công">
                  <select
                    className="w-full px-3 py-2 rounded-lg border border-line/50 bg-bg-main text-ink text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all"
                    value={selectedEmpId}
                    onChange={(e) => setSelectedEmpId(e.target.value)}
                  >
                    {scopedEmployees.map((e) => (
                      <option key={e.id} value={e.id}>{(e.display_name || '')} — {e.employee_code}</option>
                    ))}
                  </select>
                </Field>
                {emp && (
                  <div className="mt-3 space-y-1 text-xs text-info">
                    <p>Mã NV: <span className="font-mono text-ink">{emp.employee_code}</span></p>
                    <p>Chức vụ: <span className="text-ink">{emp.job_title || '—'}</span></p>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <UserCog className="w-4 h-4 text-info" />
                  <span className="text-xs font-medium text-info">Nhân viên chấm công</span>
                </div>
                <Badge color="primary">
                  Nhân viên: {myEmployee?.display_name || currentUser?.full_name || currentUser?.username || '—'}
                </Badge>
                {myEmployee && (
                  <div className="space-y-1 text-xs text-info">
                    <p>Mã NV: <span className="font-mono text-ink">{myEmployee.employee_code}</span></p>
                    <p>Chức vụ: <span className="text-ink">{myEmployee.job_title || '—'}</span></p>
                  </div>
                )}
                <p className="text-xs text-line">
                  Bạn chỉ có thể chấm công cho chính mình. Mọi thao tác được tự động gắn với hồ sơ của bạn.
                </p>
              </div>
            )}
          </div>

          {/* Today's scheduled shift */}
          <div className="bg-card rounded-xl border border-line/30 p-5">
            <div className="flex items-center gap-2 mb-3">
              <CalendarClock className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium text-info">Ca làm việc hôm nay</span>
            </div>
            {scheduledShift ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-md text-sm font-bold border bg-primary/10 text-primary border-primary/20">
                    {(scheduledShift.code || '—')}
                  </span>
                  <span className="text-sm font-medium text-ink">{scheduledShift.name}</span>
                </div>
                <p className="text-xs text-info">
                  {scheduledShift.start_time} – {scheduledShift.end_time}
                </p>
                <p className="text-xs text-line">
                  Cho phép chấm từ {(scheduledShift.start_time || '').slice(0, 5)} −{settings.window_before} phút đến +{settings.window_after} phút
                </p>
              </div>
            ) : (
              <div className="text-sm text-info py-2">
                <p>Không có ca được phân công hôm nay.</p>
                <p className="text-xs text-line mt-1">Chấm công sẽ yêu cầu phê duyệt.</p>
              </div>
            )}
          </div>

          {/* GPS status */}
          <div className="bg-card rounded-xl border border-line/30 p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-primary" />
                <span className="text-xs font-medium text-info">Vị trí GPS</span>
              </div>
              <button onClick={checkGPS} className="text-xs text-primary hover:underline" disabled={gpsStatus.loading}>
                {gpsStatus.loading ? 'Đang xác định...' : 'Cập nhật'}
              </button>
            </div>
            {gpsStatus.loading ? (
              <div className="flex items-center gap-2 text-sm text-info">
                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                <span>Đang xác định vị trí...</span>
              </div>
            ) : gpsStatus.error ? (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20">
                <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-danger">Không lấy được vị trí</p>
                  <p className="text-xs text-danger/70 mt-0.5">{gpsStatus.error}</p>
                </div>
              </div>
            ) : gpsStatus.inRadius === null ? (
              <p className="text-sm text-info">Chưa xác định vị trí.</p>
            ) : gpsStatus.inRadius ? (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-success/10 border border-success/20">
                <CheckCircle2 className="w-4 h-4 text-success" />
                <div>
                  <p className="text-sm font-medium text-success">Trong bán kính</p>
                  <p className="text-xs text-success/70">Cách khách sạn {gpsStatus.distance}m (giới hạn {settings.radius_m}m)</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-danger/10 border border-danger/20">
                <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-danger">Ngoài bán kính</p>
                  <p className="text-xs text-danger/70">Cách khách sạn {gpsStatus.distance}m (giới hạn {settings.radius_m}m)</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Clock-in actions + today's status */}
        <div className="lg:col-span-2 space-y-4">
          {/* Clock actions */}
          {canClock ? (
          <div className="bg-card rounded-xl border border-line/30 p-6">
            <div className="text-center mb-6">
              <p className="text-xs text-info mb-1">Thời gian hiện tại</p>
              <p className="text-4xl font-bold text-ink tabular-nums">{nowHHmm()}</p>
              <p className="text-xs text-line mt-1">{today}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={handleClockIn}
                disabled={!effectiveEmpId || !!todayLog?.clock_in}
                className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border-2 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                  bg-primary/5 border-primary/30 hover:bg-primary/10 hover:border-primary/50"
              >
                <LogIn className="w-8 h-8 text-primary" />
                <span className="text-sm font-bold text-primary">VÀO CA</span>
                {todayLog?.clock_in && (
                  <span className="text-xs text-success font-medium">{todayLog.clock_in}</span>
                )}
              </button>

              <button
                onClick={handleClockOut}
                disabled={!todayLog?.clock_in || !!todayLog?.clock_out}
                className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border-2 transition-all active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed
                  bg-danger/5 border-danger/30 hover:bg-danger/10 hover:border-danger/50"
              >
                <LogOut className="w-8 h-8 text-danger" />
                <span className="text-sm font-bold text-danger">RA CA</span>
                {todayLog?.clock_out && (
                  <span className="text-xs text-success font-medium">{todayLog.clock_out}</span>
                )}
              </button>
            </div>
          </div>
          ) : (
          <div className="bg-card rounded-xl border border-line/30 p-6">
            <div className="flex items-center gap-3 px-4 py-4 rounded-lg bg-info/10 border border-info/20">
              <Lock className="w-5 h-5 text-info shrink-0" />
              <div>
                <p className="text-sm font-medium text-ink">Chế độ xem — không thể chấm công</p>
                <p className="text-xs text-info mt-0.5">
                  {attLevel === 'view_all'
                    ? 'Bạn có quyền xem tất cả chấm công nhưng không thể chấm công thay người khác.'
                    : 'Quyền chấm công chưa được cấp. Vui lòng liên hệ quản lý.'}
                </p>
              </div>
            </div>
          </div>
          )}

          {/* Today's attendance status */}
          <div className="bg-card rounded-xl border border-line/30 p-5">
            <h3 className="text-sm font-semibold text-ink mb-3">Trạng thái chấm công hôm nay</h3>
            {todayLog ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-bg-main border border-line/20">
                    <p className="text-xs text-info mb-1">Giờ vào</p>
                    <p className="text-sm font-bold text-ink">{todayLog.clock_in || '—'}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-bg-main border border-line/20">
                    <p className="text-xs text-info mb-1">Giờ ra</p>
                    <p className="text-sm font-bold text-ink">{todayLog.clock_out || '—'}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-bg-main border border-line/20">
                    <p className="text-xs text-info mb-1">Trạng thái</p>
                    <div className="flex flex-col gap-1">
                      {todayLog.status === 'valid' && <Badge color="success">Đúng ca</Badge>}
                      {todayLog.status === 'pending_approval' && <Badge color="danger">Chờ duyệt</Badge>}
                      {todayLog.status === 'rejected' && <Badge color="danger">Từ chối</Badge>}
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-bg-main border border-line/20">
                    <p className="text-xs text-info mb-1">Ca lịch trình</p>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-bold border bg-primary/10 text-primary border-primary/20">
                        {(scheduledShift?.code || 'OFF').toUpperCase()}
                      </span>
                      <span className="text-xs font-medium text-ink">{scheduledShift?.name ?? 'Không có'}</span>
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-primary-soft/20 border border-primary/10">
                    <p className="text-xs text-primary mb-1">Ca điều chỉnh</p>
                    {adjustedShift ? (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-xs font-bold border bg-primary/15 text-primary border-primary/25">
                          {(adjustedShift.code || 'OFF').toUpperCase()}
                        </span>
                        <span className="text-xs font-medium text-ink">{adjustedShift.name}</span>
                        {todayLog.status === 'pending_approval' && (
                          <Badge color="danger">Chờ duyệt</Badge>
                        )}
                        {todayLog.status === 'valid' && todayLog.mismatch_reason && (
                          <Badge color="success">Đã duyệt</Badge>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-line">—</span>
                    )}
                  </div>
                </div>
                {todayLog.mismatch_reason && (
                  <div className="px-3 py-2 rounded-lg bg-warning/10 border border-warning/20">
                    <p className="text-xs text-warning font-medium">Lý do điều chỉnh: {todayLog.mismatch_reason}</p>
                  </div>
                )}
                {todayLog.is_outside_radius && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/20">
                    <MapPin className="w-3.5 h-3.5 text-danger" />
                    <p className="text-xs text-danger font-medium">Chấm công ngoài bán kính khách sạn</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center">
                <Clock className="w-10 h-10 text-line mx-auto mb-2" />
                <p className="text-sm text-info">Chưa có bản ghi chấm công cho hôm nay.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm ${
          toast.ok ? 'bg-success text-white' : 'bg-danger text-white'
        }`}>
          {toast.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Mismatch modal */}
      {showMismatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setShowMismatchModal(false)} />
          <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warning" />
                <h3 className="text-base font-semibold text-ink">Không khớp lịch làm việc</h3>
              </div>
              <button onClick={() => setShowMismatchModal(false)} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/20">
                <p className="text-sm text-warning">
                  Thời gian {clockAction === 'in' ? 'vào ca' : 'ra ca'} không khớp với lịch làm việc!
                  Vui lòng chọn ca điều chỉnh và nhập lý do để gửi Quản lý phê duyệt.
                </p>
              </div>
              <Field label="Ca điều chỉnh (bắt buộc)">
                <Select value={adjustedShiftId} onChange={(e) => setAdjustedShiftId(e.target.value)}>
                  <option value="">— Chọn ca —</option>
                  {shifts.filter((s) => s.kind === 'work').map((s) => {
                    const detected = getNearestShiftByTime(nowHHmm(), shifts);
                    const isAuto = detected?.id === s.id;
                    return (
                      <option key={s.id} value={s.id}>
                        {(s.code || 'OFF').toUpperCase()} — {s.name} ({s.start_time}–{s.end_time}){isAuto ? ' (tự phát hiện)' : ''}
                      </option>
                    );
                  })}
                </Select>
              </Field>
              <Field label="Lý do điều chỉnh (bắt buộc)">
                <TextInput
                  value={mismatchReason}
                  onChange={(e) => setMismatchReason(e.target.value)}
                  placeholder="VD: Đi trễ do kẹt xe / Đề nghị đổi ca..."
                  autoFocus
                />
              </Field>
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={() => setShowMismatchModal(false)}>Hủy</Button>
              <Button onClick={submitMismatch} disabled={!mismatchReason.trim() || !adjustedShiftId}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Gửi yêu cầu
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
