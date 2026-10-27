import { useMemo } from 'react';
import { useEmployees } from '@/hrm/store';
import { useAuth } from '@/auth/AuthContext';
import type { Employee } from '@/hrm/types';

/**
 * Resolves the active tenant (hotel) context and the set of employees
 * belonging to that hotel. Super admins in all-hotels mode see every
 * employee; everyone else is hard-scoped to their active hotel.
 */
export function useTenantScope() {
  const { user, session } = useAuth();
  const [employees] = useEmployees();
  const isSuperAdmin = !!user?.is_super_admin;
  const hotelId = session?.activeHotelId ?? null;

  const tenantEmployees: Employee[] = useMemo(() => {
    if (isSuperAdmin) return employees;
    if (!hotelId) return [];
    return employees.filter((e) => e.hotel_id === hotelId);
  }, [employees, isSuperAdmin, hotelId]);

  const tenantEmployeeIds = useMemo(
    () => new Set(tenantEmployees.map((e) => e.id)),
    [tenantEmployees],
  );

  return { hotelId, isSuperAdmin, tenantEmployees, tenantEmployeeIds };
}
