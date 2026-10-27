import { useState, useMemo, useEffect, useRef } from 'react';
import { useSchedules, useShifts, useEmployees, useWorkStatuses, getSchedulableEmployees } from '@/hrm/store';
import { useHrmPermission } from '@/hrm/usePermission';
import { useTenantScope } from '@/hrm/useTenantScope';
import type { Schedule } from '@/hrm/types';
import { Button, Badge } from '@/components/ui';
import { CalendarDays, Download, Upload, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, FileSpreadsheet, Save, Pencil, Eye, X } from 'lucide-react';
import ExportDropdown from '@/components/ExportDropdown';
import { exportToPdf } from '@/utils/pdf';
import { localDateStr } from '@/hrm/dateUtils';

const DAY_NAMES = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const DAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function formatDate(d: Date): string {
  return localDateStr(d);
}

function formatDateDisplay(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday as start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

// ── SheetJS CDN loader ────────────────────────────────────────
let xlsxLoading: Promise<void> | null = null;

function loadXLSX(): Promise<void> {
  if ((window as any).XLSX) return Promise.resolve();
  if (xlsxLoading) return xlsxLoading;

  xlsxLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Không thể tải thư viện XLSX'));
    document.head.appendChild(script);
  });

  return xlsxLoading;
}

export default function SchedulePage() {
  const [schedules, setSchedules] = useSchedules();
  const [shifts] = useShifts();
  const [employees] = useEmployees();
  const [statuses] = useWorkStatuses();
  const { can } = useHrmPermission();
  const { tenantEmployeeIds } = useTenantScope();
  const canEdit = can('hrm_schedules', 'update');
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [isEditing, setIsEditing] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<Map<string, string | null>>(new Map());
  const [importPreview, setImportPreview] = useState<ParsedSchedule[] | null>(null);
  const [importStatus, setImportStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);
  const schedulable = useMemo(
    () => getSchedulableEmployees(employees, statuses).filter((e) => tenantEmployeeIds.has(e.id)),
    [employees, statuses, tenantEmployeeIds]
  );

  const shiftMap = useMemo(() => {
    const map = new Map<string, typeof shifts[number]>();
    shifts.forEach((s) => map.set((s.code || '').toUpperCase(), s));
    return map;
  }, [shifts]);

  // Build a lookup: employee_id + date => shift
  const scheduleMap = useMemo(() => {
    const map = new Map<string, string>(); // key: "empId|date" => shiftId
    const weekStartStr = formatDate(weekDays[0]);
    const weekEndStr = formatDate(weekDays[6]);
    schedules.forEach((s) => {
      if (!tenantEmployeeIds.has(s.employee_id)) return;
      if (s.work_date >= weekStartStr && s.work_date <= weekEndStr) {
        map.set(`${s.employee_id}|${s.work_date}`, s.shift_id);
      }
    });
    return map;
  }, [schedules, weekDays, tenantEmployeeIds]);

  const getShift = (id: string) => shifts.find((s) => s.id === id);
  const getShiftColor = (shiftId: string | undefined) => {
    if (!shiftId) return '';
    const shift = getShift(shiftId);
    if (!shift) return '';
    if (shift.kind === 'off') {
      if (shift.deducts_leave) return 'bg-danger/10 text-danger border-danger/20';
      return 'bg-info/10 text-info border-line/30';
    }
    return 'bg-primary/10 text-primary border-primary/20';
  };

  const shiftWeekLabel = `${formatDateDisplay(weekDays[0])} – ${formatDateDisplay(weekDays[6])}`;

  const prevWeek = () => setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7));
  const nextWeek = () => setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7));
  const thisWeek = () => setWeekStart(getWeekStart(new Date()));

  // ── Download Template ────────────────────────────────────────
  const downloadTemplate = async () => {
    await loadXLSX();
    const XLSX = (window as any).XLSX;

    // Build header row: Ngày, Thứ, emp1, emp2, ...
    const header = ['Ngày', 'Thứ', ...schedulable.map((e) => e.display_name)];

    // Build data rows: 7 days with sample shift codes
    const sampleShifts = ['S', 'C', 'D', 'OFF', 'P'];
    const rows = weekDays.map((day, i) => {
      const dayName = DAY_NAMES[day.getDay()];
      return [
        formatDateDisplay(day),
        dayName,
        ...schedulable.map((_, ei) => sampleShifts[(i + ei) % sampleShifts.length]),
      ];
    });

    const wsData = [header, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, ...schedulable.map(() => ({ wch: 18 }))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lịch làm việc');
    XLSX.writeFile(wb, `Lich_lam_viec_${shiftWeekLabel.replace(/[/\s–]/g, '_')}.xlsx`);
  };

  // ── Import Excel ─────────────────────────────────────────────
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      await loadXLSX();
      const XLSX = (window as any).XLSX;

      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const jsonData: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      if (jsonData.length < 2) {
        setImportStatus({ ok: false, msg: 'File không hợp lệ. Cần ít nhất 1 hàng tiêu đề và 1 hàng dữ liệu.' });
        return;
      }

      // Row 1 = header: [Ngày, Thứ, empName1, empName2, ...]
      const headerRow = jsonData[0].map((c: any) => String(c).trim());
      const empNames = headerRow.slice(2);

      // Map employee names to IDs
      const nameToId = new Map<string, string>();
      schedulable.forEach((emp) => {
        nameToId.set((emp.display_name || '').toLowerCase(), emp.id);
      });

      // Build parsed schedule entries
      const parsed: ParsedSchedule[] = [];
      const errors: string[] = [];
      let rowIdx = 1;

      for (let r = 1; r < jsonData.length; r++) {
        const row = jsonData[r];
        const dateStr = String(row[0] || '').trim();
        const dayName = String(row[1] || '').trim();

        if (!dateStr) continue;

        // Parse date from dd/mm/yyyy
        let workDate = '';
        const parts = dateStr.split('/');
        if (parts.length === 3) {
          const dd = parts[0].padStart(2, '0');
          const mm = parts[1].padStart(2, '0');
          const yyyy = parts[2];
          workDate = `${yyyy}-${mm}-${dd}`;
        } else {
          // Try parsing as Date object
          const parsed_date = XLSX.SSF.parse(dateStr);
          if (parsed_date instanceof Date) {
            workDate = formatDate(parsed_date);
          }
        }

        if (!workDate) {
          errors.push(`Hàng ${r + 1}: Không đọc được ngày "${dateStr}"`);
          continue;
        }

        // Parse each employee's shift
        for (let c = 2; c < row.length; c++) {
          const shiftCode = String(row[c] || '').trim().toUpperCase();
          if (!shiftCode) continue;

          const empName = empNames[c - 2];
          if (!empName) continue;

          const empId = nameToId.get((empName || '').toLowerCase());
          if (!empId) {
            errors.push(`Hàng ${r + 1}: Không tìm thấy nhân viên "${empName}"`);
            continue;
          }

          const shift = shiftMap.get(shiftCode);
          if (!shift) {
            errors.push(`Hàng ${r + 1}, ${empName}: Mã ca "${shiftCode}" không hợp lệ`);
            continue;
          }

          parsed.push({
            employee_id: empId,
            employee_name: empName,
            work_date: workDate,
            shift_code: shiftCode,
            shift_id: shift.id,
            shift_name: shift.name,
          });
        }
        rowIdx++;
      }

      if (parsed.length === 0) {
        setImportStatus({ ok: false, msg: 'Không có dữ liệu lịch nào được đọc từ file.' });
        return;
      }

      setImportPreview(parsed);
      setImportStatus(errors.length > 0 ? { ok: true, msg: `Đã đọc ${parsed.length} mục, ${errors.length} cảnh báo.` } : { ok: true, msg: `Đã đọc ${parsed.length} mục.` });
    } catch (err) {
      setImportStatus({ ok: false, msg: 'Lỗi khi đọc file: ' + (err as Error).message });
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confirmImport = () => {
    if (!importPreview) return;

    const importedDates = new Set(importPreview.map((p) => p.work_date));
    const importId = `imp_${Date.now()}`;

    setSchedules((prev) => {
      // Remove existing schedules for imported dates, then add new ones
      const filtered = prev.filter((s) => !importedDates.has(s.work_date));
      const newSchedules: Schedule[] = importPreview.map((p) => ({
        employee_id: p.employee_id,
        work_date: p.work_date,
        shift_id: p.shift_id,
        import_id: importId,
      }));
      return [...filtered, ...newSchedules];
    });

    setImportPreview(null);
    setImportStatus({ ok: true, msg: `Đã nhập ${importPreview.length} mục lịch làm việc thành công.` });
  };

  const saveChanges = () => {
    if (pendingChanges.size === 0) {
      setIsEditing(false);
      return;
    }
    setSchedules((prev) => {
      let next = [...prev];
      for (const [key, shiftId] of pendingChanges.entries()) {
        const [empId, dateStr] = key.split('|');
        next = next.filter((s) => !(s.employee_id === empId && s.work_date === dateStr));
        if (shiftId) {
          next.push({ employee_id: empId, work_date: dateStr, shift_id: shiftId });
        }
      }
      return next;
    });
    setPendingChanges(new Map());
    setIsEditing(false);
  };

  const cancelChanges = () => {
    setPendingChanges(new Map());
    setIsEditing(false);
  };

  const exportScheduleExcel = async () => {
    await loadXLSX();
    const XLSX = (window as any).XLSX;
    const header = ['Nhân viên', 'Mã NV', ...weekDays.map((d) => `${DAY_SHORT[d.getDay()]} ${formatDateDisplay(d)}`)];
    const rows = schedulable.map((emp) => {
      const cells = weekDays.map((day) => {
        const sid = scheduleMap.get(`${emp.id}|${formatDate(day)}`);
        const sh = sid ? getShift(sid) : null;
        return sh ? (sh.code || '').toUpperCase() : '';
      });
      return [emp.display_name, emp.employee_code, ...cells];
    });
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = [{ wch: 18 }, { wch: 10 }, ...weekDays.map(() => ({ wch: 12 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lịch làm việc');
    XLSX.writeFile(wb, `Lich_lam_viec_${shiftWeekLabel.replace(/[/\s–]/g, '_')}.xlsx`);
  };

  const exportSchedulePdf = () => {
    const columns = [
      { label: 'Nhân viên' },
      { label: 'Mã NV', width: '80px' },
      ...weekDays.map((d) => ({ label: `${DAY_SHORT[d.getDay()]} ${formatDateDisplay(d)}` })),
    ];
    const rows = schedulable.map((emp) => {
      const cells = weekDays.map((day) => {
        const sid = scheduleMap.get(`${emp.id}|${formatDate(day)}`);
        const sh = sid ? getShift(sid) : null;
        return sh ? (sh.code || '').toUpperCase() : '—';
      });
      return [emp.display_name, emp.employee_code, ...cells];
    });
    exportToPdf({
      title: 'Lịch làm việc',
      subtitle: `Tuần ${shiftWeekLabel}`,
      columns,
      rows,
      fileName: `Lich_lam_viec_${shiftWeekLabel.replace(/[/\s–]/g, '_')}.pdf`,
    });
  };

  return (
    <div className="px-8 pt-6 pb-8">
      {/* Page header */}
      <div className="mb-6">
        <nav className="flex items-center gap-1.5 text-xs font-medium text-info mb-2">
          <span>HRM</span>
          <span className="text-line">›</span>
          <span className="text-ink">Lịch làm việc</span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <CalendarDays className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink leading-tight">Lịch làm việc</h1>
              <p className="text-sm text-info mt-0.5">Lập và quản lý lịch làm việc theo ca cho từng phòng ban.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isEditing && canEdit ? (
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                <Pencil className="w-4 h-4" /> Chỉnh sửa lịch
              </Button>
            ) : isEditing ? (
              <>
                <Button onClick={saveChanges}>
                  <Save className="w-4 h-4" /> Lưu thay đổi
                </Button>
                <Button variant="secondary" onClick={cancelChanges}>
                  <X className="w-4 h-4" /> Hủy
                </Button>
              </>
            ) : null}
            <Button variant="secondary" onClick={downloadTemplate} disabled={isEditing}>
              <Download className="w-4 h-4" /> Tải file mẫu (.xlsx)
            </Button>
            <Button onClick={() => fileInputRef.current?.click()} disabled={isEditing}>
              <Upload className="w-4 h-4" /> Nhập lịch (Excel)
            </Button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileUpload} className="hidden" />
            <ExportDropdown options={[
              { key: 'xlsx', label: 'Xuất Excel (.xlsx)', icon: 'xlsx', onClick: exportScheduleExcel },
              { key: 'pdf', label: 'Xuất PDF (.pdf)', icon: 'pdf', onClick: exportSchedulePdf },
            ]} />
          </div>
        </div>
      </div>

      {/* Week navigator */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={prevWeek} className="p-2 rounded-lg border border-line/40 text-info hover:bg-primary-soft/30 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-4 py-2 rounded-lg bg-card border border-line/30 text-sm font-medium text-ink min-w-[200px] text-center">
            {shiftWeekLabel}
          </div>
          <button onClick={nextWeek} className="p-2 rounded-lg border border-line/40 text-info hover:bg-primary-soft/30 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          <Button variant="ghost" size="sm" onClick={thisWeek}>Tuần này</Button>
        </div>
        <div className="text-xs text-info">
          {schedulable.length} nhân viên · {schedules.length} mục lịch
        </div>
      </div>

      {/* Import status */}
      {importStatus && !importPreview && (
        <div className={`mb-4 flex items-center gap-2 px-4 py-3 rounded-lg text-sm ${
          importStatus.ok ? 'bg-success/10 text-success border border-success/20' : 'bg-danger/10 text-danger border border-danger/20'
        }`}>
          {importStatus.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span>{importStatus.msg}</span>
          <button onClick={() => setImportStatus(null)} className="ml-auto text-current opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Schedule grid */}
      <div className="bg-card rounded-xl border border-line/30 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line/30 text-info text-xs bg-bg-main/50">
                <th className="text-left py-3 px-4 font-medium sticky left-0 bg-bg-main/50 z-10 min-w-[160px]">Nhân viên</th>
                {weekDays.map((day, i) => {
                  const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                  return (
                    <th key={i} className={`text-center py-3 px-2 font-medium min-w-[100px] ${isWeekend ? 'text-danger/60' : ''}`}>
                      <div className="text-xs">{DAY_NAMES[day.getDay()]}</div>
                      <div className={`text-[10px] mt-0.5 ${isWeekend ? 'text-danger/40' : 'text-line'}`}>{formatDateDisplay(day)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {schedulable.map((emp) => (
                <tr key={emp.id} className="border-b border-line/20 hover:bg-bg-main/30 transition-colors">
                  <td className="py-2.5 px-4 sticky left-0 bg-card z-10">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink text-sm">{emp.display_name}</span>
                      <span className="text-[10px] text-line font-mono">{emp.employee_code}</span>
                    </div>
                  </td>
                  {weekDays.map((day, di) => {
                    const dateStr = formatDate(day);
                    const key = `${emp.id}|${dateStr}`;
                    const baseShiftId = scheduleMap.get(key) ?? null;
                    const hasPending = pendingChanges.has(key);
                    const shiftId = hasPending ? pendingChanges.get(key) : baseShiftId;
                    const shift = shiftId ? getShift(shiftId) : null;
                    return (
                      <td key={di} className="py-2 px-1 text-center">
                        {isEditing ? (
                          <select
                            value={shiftId ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPendingChanges((prev) => { const m = new Map(prev); m.set(key, val || null); return m; });
                            }}
                            className={`w-full text-center text-xs font-medium rounded-md border px-1 py-1.5 cursor-pointer bg-transparent transition-all focus:outline-none focus:ring-1 focus:ring-primary/40 ${shift ? getShiftColor(shiftId) : 'text-line border-transparent hover:border-line/40'}`}
                          >
                            <option value="">—</option>
                            {shifts.map((s) => (
                              <option key={s.id} value={s.id}>{(s.code || '').toUpperCase()} · {s.name}</option>
                            ))}
                          </select>
                        ) : shift ? (
                          <span className={`inline-flex items-center justify-center px-2 py-1 rounded-md text-xs font-medium border ${getShiftColor(shiftId)}`}>
                            {shift.code}
                          </span>
                        ) : (
                          <span className="text-line text-xs">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {schedulable.length === 0 && (
          <div className="py-12 text-center">
            <CalendarDays className="w-10 h-10 text-line mx-auto mb-2" />
            <p className="text-sm text-info">Chưa có nhân viên nào có thể phân lịch</p>
          </div>
        )}
      </div>

      {/* Import preview modal */}
      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setImportPreview(null)} />
          <div className="relative w-full max-w-3xl bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <div className="flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-primary" />
                <h3 className="text-base font-semibold text-ink">Xác nhận nhập lịch</h3>
              </div>
              <button onClick={() => setImportPreview(null)} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <p className="text-sm text-info mb-3">
                Đã đọc <span className="font-medium text-ink">{importPreview.length}</span> mục lịch. Vui lòng kiểm tra trước khi lưu.
              </p>
              <div className="overflow-x-auto rounded-lg border border-line/30">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line/30 text-info text-xs bg-bg-main/50">
                      <th className="text-left py-2.5 px-3 font-medium">Nhân viên</th>
                      <th className="text-left py-2.5 px-3 font-medium">Ngày</th>
                      <th className="text-left py-2.5 px-3 font-medium">Ca</th>
                      <th className="text-left py-2.5 px-3 font-medium">Tên ca</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.slice(0, 50).map((p, i) => (
                      <tr key={i} className="border-b border-line/20">
                        <td className="py-2 px-3 text-ink">{p.employee_name}</td>
                        <td className="py-2 px-3 text-info">{p.work_date}</td>
                        <td className="py-2 px-3"><Badge color="primary">{p.shift_code}</Badge></td>
                        <td className="py-2 px-3 text-info">{p.shift_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {importPreview.length > 50 && (
                <p className="text-xs text-info mt-2">... và {importPreview.length - 50} mục khác</p>
              )}
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-between">
              <span className="text-xs text-info">{importStatus?.msg}</span>
              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={() => setImportPreview(null)}>Hủy</Button>
                <Button onClick={confirmImport}><Save className="w-3.5 h-3.5" /> Lưu lịch</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────
interface ParsedSchedule {
  employee_id: string;
  employee_name: string;
  work_date: string;
  shift_code: string;
  shift_id: string;
  shift_name: string;
}
