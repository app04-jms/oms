import { useState, useMemo, useRef } from 'react';
import { useEmployees, useDepartments, useWorkStatuses, nextEmployeeCode, genId } from '@/hrm/store';
import type { Employee } from '@/hrm/types';
import { Field, TextInput, Select, Toggle, Button, Badge } from '@/components/ui';
import { Users, Plus, Pencil, Trash2, Search, Save, Phone, Calendar, Briefcase, Download, Upload, FileDown, UserPlus, KeyRound, ShieldCheck } from 'lucide-react';
import { createUserFromEmployee, createUsersFromEmployeeList } from '@/store/authStore';
import { useRouter } from '@/router/RouterContext';
import { localDateStr } from '@/hrm/dateUtils';
import { useAuth } from '@/auth/AuthContext';
import { useHrmPermission } from '@/hrm/usePermission';
import { useTenantScope } from '@/hrm/useTenantScope';
import { exportToXlsx, downloadTemplate, parseXlsx, type SheetColumn } from '@/utils/xlsx';
import { generateUniqueId } from '@/utils/idGenerator';

const EMPLOYEE_COLUMNS: SheetColumn<Employee>[] = [
  { key: 'employee_code', label: 'Mã NV' },
  { key: 'display_name', label: 'Tên hiển thị' },
  { key: 'full_name', label: 'Họ tên đầy đủ' },
  { key: 'department_id', label: 'Bộ phận' },
  { key: 'job_title', label: 'Chức vụ' },
  { key: 'phone', label: 'Điện thoại' },
  { key: 'start_date', label: 'Ngày bắt đầu' },
  { key: 'status_id', label: 'Trạng thái' },
  { key: 'has_leave', label: 'Có phép', fromCell: (raw) => String(raw).toLowerCase() === 'true' || raw === '1' || raw === 1 },
  { key: 'opening_leave_balance', label: 'Số dư phép', fromCell: (raw) => Number(raw) || 0 },
  { key: 'base_salary', label: 'Lương cơ bản', fromCell: (raw) => Number(raw) || 0 },
];

function resolveDeptId(name: string, departments: { id: string; name: string }[]): string {
  const n = (name || '').trim().toLowerCase();
  const found = departments.find((d) => d.name.toLowerCase() === n);
  if (found) return found.id;
  return departments[0]?.id ?? '';
}

function resolveStatusId(name: string, statuses: { id: string; name: string }[]): string {
  const n = (name || '').trim().toLowerCase();
  const found = statuses.find((s) => s.name.toLowerCase() === n);
  if (found) return found.id;
  return statuses[0]?.id ?? '';
}

const TABS = [
  { key: 'all', label: 'Tất cả' },
  { key: 'active', label: 'Đang làm việc' },
  { key: 'inactive', label: 'Đã nghỉ việc' },
];

export default function EmployeesPage() {
  const [employees, setEmployees] = useEmployees();
  const [departments] = useDepartments();
  const [statuses] = useWorkStatuses();
  const { session, user } = useAuth();
  const { navigate } = useRouter();
  const { getLevel, LEVEL_RANK } = useHrmPermission();
  const empLevel = getLevel('hrm_profiles');
  const { hotelId: activeHotelId, isSuperAdmin } = useTenantScope();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  // Account-creation dialog state
  const [accountPrompt, setAccountPrompt] = useState<{ employee: Employee } | null>(null);
  const [accountPassword, setAccountPassword] = useState('123456');
  const [createdAccount, setCreatedAccount] = useState<{ code: string; userId: string } | null>(null);
  // Bulk account creation dialog state
  const [bulkPrompt, setBulkPrompt] = useState<{ employees: Employee[] } | null>(null);
  const [bulkPassword, setBulkPassword] = useState('123456');
  const [bulkResult, setBulkResult] = useState<{ created: number; skipped: number } | null>(null);

  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '—';
  const statusName = (id: string) => statuses.find((s) => s.id === id)?.name ?? '—';
  const statusObj = (id: string) => statuses.find((s) => s.id === id);

  // Resolve current user's linked employee for personal-scope scoping
  const myEmployee = useMemo(() => {
    if (!user) return null;
    return employees.find((e) => e.user_id === user.id)
      ?? (user.employee_id ? employees.find((e) => e.id === user.employee_id) : null)
      ?? employees.find((e) => e.employee_code === user.username)
      ?? null;
  }, [employees, user]);

  const canEditEmployees = LEVEL_RANK[empLevel] >= LEVEL_RANK.update;

  const filtered = useMemo(() => {
    let list = employees;
    if (!isSuperAdmin && activeHotelId) {
      list = list.filter((e) => e.hotel_id === activeHotelId);
    } else if (!isSuperAdmin && !activeHotelId) {
      return [];
    }
    // Scope: 'view' level shows only the current user's linked employee record;
    // 'view_all' and above shows all employees.
    if (empLevel === 'hidden') return [];
    if (empLevel === 'view' && !user?.is_super_admin) {
      list = myEmployee ? [myEmployee] : [];
    }
    if (activeTab === 'active') {
      list = list.filter((e) => statusObj(e.status_id)?.can_schedule_and_clock);
    } else if (activeTab === 'inactive') {
      list = list.filter((e) => !statusObj(e.status_id)?.can_schedule_and_clock);
    }
    if (filterDept) list = list.filter((e) => e.department_id === filterDept);
    if (filterStatus) list = list.filter((e) => e.status_id === filterStatus);
    if (search.trim()) {
      const q = (search || '').toLowerCase();
      list = list.filter((e) =>
        (e.display_name || '').toLowerCase().includes(q) ||
        (e.employee_code || '').toLowerCase().includes(q) ||
        (e.job_title || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [employees, activeTab, filterDept, filterStatus, search, departments, statuses, empLevel, myEmployee, user, isSuperAdmin, activeHotelId]);

  const blankEmployee = (): Employee => ({
    id: genId('e_'),
    employee_code: nextEmployeeCode(employees),
    display_name: '',
    full_name: '',
    department_id: departments[0]?.id ?? '',
    job_title: '',
    phone: '',
    start_date: localDateStr(),
    status_id: statuses[0]?.id ?? '',
    has_leave: true,
    opening_leave_balance: 12,
    user_id: null,
    hotel_id: activeHotelId ?? undefined,
  });

  const handleSave = (emp: Employee) => {
    const withTenant: Employee = { ...emp, hotel_id: emp.hotel_id || activeHotelId || undefined };
    setEmployees((prev) => {
      const exists = prev.some((e) => e.id === withTenant.id);
      return exists ? prev.map((e) => (e.id === withTenant.id ? withTenant : e)) : [...prev, withTenant];
    });
    setShowForm(false);
    setEditing(null);
    // For newly-created employees, prompt to create a login account
    const wasNew = !employees.some((e) => e.id === withTenant.id);
    if (wasNew) {
      setAccountPassword('123456');
      setAccountPrompt({ employee: withTenant });
    }
  };

  const confirmCreateAccount = () => {
    if (!accountPrompt) return;
    const emp = accountPrompt.employee;
    const created = createUserFromEmployee(emp, accountPassword || '123456', activeHotelId ?? null, {
      is_super_admin: user?.is_super_admin ?? false,
      activeHotelId: activeHotelId ?? null,
    });
    setAccountPrompt(null);
    if (created) {
      setCreatedAccount({ code: emp.employee_code, userId: created.id });
    } else {
      setImportMsg(`Tài khoản ${emp.employee_code} đã tồn tại. Không tạo mới.`);
    }
  };

  const skipCreateAccount = () => setAccountPrompt(null);

  const goToUserManagement = () => {
    setCreatedAccount(null);
    navigate('/system/users');
  };

  const handleDelete = (id: string) => {
    setEmployees((prev) => prev.filter((e) => e.id !== id));
  };

  const handleDownloadTemplate = () => {
    downloadTemplate<Employee>(
      EMPLOYEE_COLUMNS,
      'Mau_nhan_vien',
      { employee_code: 'NV006', display_name: 'Nguyễn Văn F', full_name: 'Nguyễn Văn F', department_id: 'Lễ tân', job_title: 'Lễ tân', phone: '0901234567', start_date: '2024-01-15', status_id: 'Đang làm việc', has_leave: true, opening_leave_balance: 12, base_salary: 8000000 },
    );
  };

  const handleExport = () => {
    const rows = filtered.map((e) => ({
      ...e,
      department_id: deptName(e.department_id),
      status_id: statusName(e.status_id),
    }));
    exportToXlsx<Employee>(rows as Employee[], EMPLOYEE_COLUMNS, 'Danh_sach_nhan_vien');
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseXlsx<Employee>(file, EMPLOYEE_COLUMNS);
      const imported: Employee[] = [];
      setEmployees((prev) => {
        const next = [...prev];
        for (const row of parsed) {
          if (!row.display_name || !String(row.display_name).trim()) continue;
          const id = generateUniqueId('emp_');
          const emp: Employee = {
            id,
            employee_code: String(row.employee_code || '').trim() || nextEmployeeCode(next),
            display_name: String(row.display_name).trim(),
            full_name: String(row.full_name || row.display_name).trim(),
            department_id: resolveDeptId(String(row.department_id || ''), departments),
            job_title: String(row.job_title || '').trim(),
            phone: String(row.phone || '').trim(),
            start_date: String(row.start_date || localDateStr()).trim(),
            status_id: resolveStatusId(String(row.status_id || ''), statuses),
            has_leave: !!row.has_leave,
            opening_leave_balance: Number(row.opening_leave_balance) || 0,
            user_id: null,
            hotel_id: activeHotelId ?? undefined,
            base_salary: Number(row.base_salary) || 0,
          };
          next.push(emp);
          imported.push(emp);
        }
        return next;
      });
      const count = imported.length;
      setImportMsg(`Đã nhập ${count} nhân viên.`);
      if (count > 0) {
        setBulkPassword('123456');
        setBulkPrompt({ employees: imported });
      }
    } catch {
      setImportMsg('Lỗi đọc file Excel. Vui lòng kiểm tra định dạng.');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const confirmBulkCreate = () => {
    if (!bulkPrompt) return;
    const created = createUsersFromEmployeeList(
      bulkPrompt.employees,
      bulkPassword || '123456',
      activeHotelId ?? null,
      { is_super_admin: user?.is_super_admin ?? false, activeHotelId: activeHotelId ?? null },
    );
    const total = bulkPrompt.employees.length;
    setBulkPrompt(null);
    setBulkResult({ created: created.length, skipped: total - created.length });
  };

  const skipBulkCreate = () => setBulkPrompt(null);

  return (
    <div className="px-8 pt-6 pb-8">
      {/* Page header with tabs */}
      <div className="mb-6">
        <nav className="flex items-center gap-1.5 text-xs font-medium text-info mb-2">
          <span>HRM</span>
          <span className="text-line">›</span>
          <span className="text-ink">Hồ sơ nhân viên</span>
        </nav>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-ink leading-tight">Hồ sơ nhân viên</h1>
              <p className="text-sm text-info mt-0.5">Quản lý thông tin và hồ sơ của nhân viên khách sạn.</p>
            </div>
          </div>
          {canEditEmployees && (
            <Button onClick={() => { setEditing(blankEmployee()); setShowForm(true); }}>
              <Plus className="w-4 h-4" /> Thêm nhân viên
            </Button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex gap-1 bg-primary-soft/30 border border-line/40 rounded-lg p-1">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-all ${
                  activeTab === tab.key ? 'bg-primary text-white shadow-sm' : 'text-info hover:text-ink'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button variant="secondary" size="sm" onClick={handleDownloadTemplate}>
              <FileDown className="w-3.5 h-3.5" /> Tải File Mẫu
            </Button>
            <Button variant="secondary" size="sm" onClick={handleExport}>
              <Download className="w-3.5 h-3.5" /> Xuất Excel
            </Button>
            <Button variant="secondary" size="sm" onClick={handleImportClick}>
              <Upload className="w-3.5 h-3.5" /> Nhập Excel
            </Button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleImportFile} className="hidden" />
          </div>
        </div>
        {importMsg && (
          <p className="mt-2 text-xs text-info">{importMsg}</p>
        )}
      </div>

      {/* Filters */}
      <div className="bg-card rounded-xl border border-line/30 p-4 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-line" />
            <TextInput
              className="pl-10"
              placeholder="Tìm theo tên, mã NV, chức vụ..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className="w-auto">
            <option value="">Tất cả bộ phận</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="w-auto">
            <option value="">Tất cả trạng thái</option>
            {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-line/30 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line/30 text-info text-xs bg-bg-main/50">
                <th className="text-left py-3 px-4 font-medium">Mã NV</th>
                <th className="text-left py-3 px-4 font-medium">Họ tên</th>
                <th className="text-left py-3 px-4 font-medium">Bộ phận</th>
                <th className="text-left py-3 px-4 font-medium">Chức vụ</th>
                <th className="text-left py-3 px-4 font-medium">Điện thoại</th>
                <th className="text-left py-3 px-4 font-medium">Trạng thái</th>
                <th className="text-left py-3 px-4 font-medium">Phép</th>
                <th className="text-right py-3 px-4 font-medium">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((emp) => {
                const st = statusObj(emp.status_id);
                return (
                  <tr key={emp.id} className="border-b border-line/20 hover:bg-bg-main/40 transition-colors">
                    <td className="py-3 px-4"><span className="font-mono text-xs font-medium text-ink">{emp.employee_code}</span></td>
                    <td className="py-3 px-4"><span className="font-medium text-ink">{emp.display_name}</span></td>
                    <td className="py-3 px-4 text-info">{deptName(emp.department_id)}</td>
                    <td className="py-3 px-4 text-info">{emp.job_title}</td>
                    <td className="py-3 px-4 text-info">{emp.phone || '—'}</td>
                    <td className="py-3 px-4">
                      <Badge color={st?.can_schedule_and_clock ? 'success' : 'danger'}>{statusName(emp.status_id)}</Badge>
                    </td>
                    <td className="py-3 px-4">
                      {emp.has_leave ? <Badge color="primary">Có</Badge> : <span className="text-line text-xs">Không</span>}
                    </td>
                    <td className="py-3 px-4">
                      {canEditEmployees ? (
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => { setEditing(emp); setShowForm(true); }} className="p-1.5 rounded text-info hover:bg-primary-soft/40 transition-colors">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(emp.id)} className="p-1.5 rounded text-danger hover:bg-danger/10 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-line">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="py-12 text-center">
            <Users className="w-10 h-10 text-line mx-auto mb-2" />
            <p className="text-sm text-info">Không tìm thấy nhân viên nào</p>
          </div>
        )}
      </div>

      {showForm && editing && (
        <EmployeeFormModal
          employee={editing}
          departments={departments}
          statuses={statuses}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditing(null); }}
        />
      )}

      {/* Account creation confirmation dialog */}
      {accountPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={skipCreateAccount} />
          <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-primary" /> Tạo tài khoản đăng nhập
              </h3>
              <button onClick={skipCreateAccount} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-info">
                Tạo tài khoản đăng nhập cho nhân viên{' '}
                <span className="font-semibold text-ink">{accountPrompt.employee.employee_code}</span>{' '}
                ({accountPrompt.employee.display_name})?
              </p>
              <Field label="Mật khẩu">
                <TextInput value={accountPassword} onChange={(e) => setAccountPassword(e.target.value)} placeholder="123456" />
              </Field>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary-soft/20 border border-primary/10 text-xs text-info">
                <KeyRound className="w-3.5 h-3.5 shrink-0 text-primary" />
                <span>Tài khoản sẽ được tạo với tên đăng nhập là mã nhân viên và tất cả quyền mặc định là "Không hiển thị".</span>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={skipCreateAccount}>Bỏ qua</Button>
              <Button onClick={confirmCreateAccount}><Save className="w-3.5 h-3.5" /> Tạo tài khoản</Button>
            </div>
          </div>
        </div>
      )}

      {/* Success notice with link to User Management */}
      {createdAccount && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setCreatedAccount(null)} />
          <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-success" /> Tài khoản đã tạo
              </h3>
              <button onClick={() => setCreatedAccount(null)} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-ink">
                Đã tạo tài khoản <span className="font-mono font-semibold">{createdAccount.code}</span>.
              </p>
              <p className="text-sm text-info">Vui lòng phân quyền cho tài khoản này.</p>
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={() => setCreatedAccount(null)}>Đóng</Button>
              <Button onClick={goToUserManagement}><ShieldCheck className="w-3.5 h-3.5" /> Phân quyền ngay</Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk account creation dialog */}
      {bulkPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={skipBulkCreate} />
          <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" /> Tạo tài khoản hàng loạt
              </h3>
              <button onClick={skipBulkCreate} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <p className="text-sm text-info">
                Đã nhập thành công <span className="font-semibold text-ink">{bulkPrompt.employees.length}</span> nhân viên.
                Bạn có muốn tự động tạo tài khoản đăng nhập cho tất cả nhân viên này không?
              </p>
              <Field label="Mật khẩu mặc định">
                <TextInput value={bulkPassword} onChange={(e) => setBulkPassword(e.target.value)} placeholder="123456" />
              </Field>
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary-soft/20 border border-primary/10 text-xs text-info">
                <KeyRound className="w-3.5 h-3.5 shrink-0 text-primary" />
                <span>Mỗi nhân viên sẽ có tên đăng nhập là mã nhân viên, mật khẩu chung, và tất cả quyền mặc định là "Không hiển thị".</span>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={skipBulkCreate}>Bỏ qua</Button>
              <Button onClick={confirmBulkCreate}><Save className="w-3.5 h-3.5" /> Tạo tài khoản</Button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk result notice */}
      {bulkResult && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={() => setBulkResult(null)} />
          <div className="relative w-full max-w-md bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-success" /> Tạo tài khoản hoàn tất
              </h3>
              <button onClick={() => setBulkResult(null)} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <p className="text-sm text-ink">
                Đã tạo <span className="font-semibold">{bulkResult.created}</span> tài khoản mới.
                {bulkResult.skipped > 0 && (
                  <span className="text-info"> {bulkResult.skipped} nhân viên đã có tài khoản từ trước.</span>
                )}
              </p>
              <p className="text-sm text-info">Vui lòng phân quyền cho các tài khoản này.</p>
            </div>
            <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={() => setBulkResult(null)}>Đóng</Button>
              <Button onClick={goToUserManagement}><ShieldCheck className="w-3.5 h-3.5" /> Đến Quản lý Người dùng</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmployeeFormModal({
  employee,
  departments,
  statuses,
  onSave,
  onClose,
}: {
  employee: Employee;
  departments: { id: string; name: string }[];
  statuses: { id: string; name: string; can_schedule_and_clock: boolean }[];
  onSave: (e: Employee) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Employee>(employee);
  const isNew = !employee.display_name;

  const submit = () => {
    if (!form.display_name.trim()) return;
    onSave({
      ...form,
      full_name: form.full_name.trim() || form.display_name.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-card rounded-2xl shadow-2xl border border-line/30 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line/30">
          <h3 className="text-base font-semibold text-ink">{isNew ? 'Thêm nhân viên' : 'Sửa thông tin nhân viên'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-info hover:bg-primary-soft/40 transition-colors">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Mã nhân viên">
              <TextInput value={form.employee_code} readOnly className="bg-primary-soft/20 text-info" />
            </Field>
            <Field label="Ngày bắt đầu">
              <TextInput type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
            </Field>
          </div>
          <Field label="Tên hiển thị">
            <TextInput value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="VD: Nguyễn Văn An" autoFocus />
          </Field>
          <Field label="Họ tên đầy đủ">
            <TextInput value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Bỏ trống nếu giống tên hiển thị" />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Bộ phận">
              <Select value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label="Chức vụ">
              <TextInput value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="VD: Lễ tân" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Số điện thoại">
 <TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0901234567" />
            </Field>
            <Field label="Trạng thái làm việc">
              <Select value={form.status_id} onChange={(e) => setForm({ ...form, status_id: e.target.value })}>
                {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="p-4 rounded-lg bg-primary-soft/20 border border-primary/10 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-ink">Có quyền phép</span>
                <p className="text-xs text-info">Bật nếu nhân viên được tích lũy ngày phép</p>
              </div>
              <Toggle checked={form.has_leave} onChange={(v) => setForm({ ...form, has_leave: v })} />
            </div>
            {form.has_leave && (
              <Field label="Số dư phép mở đầu (ngày)">
                <TextInput type="number" step="0.5" min="0" value={form.opening_leave_balance} onChange={(e) => setForm({ ...form, opening_leave_balance: parseFloat(e.target.value) || 0 })} />
              </Field>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-line/30 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>Hủy</Button>
          <Button onClick={submit}><Save className="w-3.5 h-3.5" /> Lưu</Button>
        </div>
      </div>
    </div>
  );
}
