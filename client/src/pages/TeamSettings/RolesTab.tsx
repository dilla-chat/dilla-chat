import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTeamStore, type Role } from '../../stores/teamStore';
import { api } from '../../services/api';
import { PERMISSION_FLAGS } from './types';

export default function RolesTab({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const { roles, setRoles } = useTeamStore();
  const teamRoles = roles.get(teamId) ?? [];
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#8fa3b8');
  const [editPermissions, setEditPermissions] = useState(0);

  const selectedRole = teamRoles.find((r) => r.id === selectedRoleId);

  const selectRole = (role: Role) => {
    setSelectedRoleId(role.id);
    setEditName(role.name);
    setEditColor(role.color || '#8fa3b8');
    setEditPermissions(role.permissions);
  };

  const handleCreateRole = async () => {
    try {
      const result = (await api.createRole(teamId, {
        name: 'New Role',
        color: '#8fa3b8',
        permissions: 0,
      })) as Role;
      setRoles(teamId, [...teamRoles, result]);
      selectRole(result);
    } catch {
      // Error
    }
  };

  const handleSaveRole = async () => {
    if (!selectedRoleId) return;
    try {
      await api.updateRole(teamId, selectedRoleId, {
        name: editName,
        color: editColor,
        permissions: editPermissions,
      });
      setRoles(
        teamId,
        teamRoles.map((r) =>
          r.id === selectedRoleId
            ? { ...r, name: editName, color: editColor, permissions: editPermissions }
            : r,
        ),
      );
    } catch {
      // Error
    }
  };

  const handleDeleteRole = async () => {
    if (!selectedRoleId || selectedRole?.isDefault) return;
    try {
      await api.deleteRole(teamId, selectedRoleId);
      setRoles(
        teamId,
        teamRoles.filter((r) => r.id !== selectedRoleId),
      );
      setSelectedRoleId(null);
    } catch {
      // Error
    }
  };

  const togglePermission = (bit: number) => {
    setEditPermissions((prev) => (prev & bit ? prev & ~bit : prev | bit));
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.roles')}</h2>

      <button className="btn-primary" onClick={handleCreateRole} style={{ marginBottom: 16 }}>
        {t('roles.create', 'Create Role')}
      </button>

      <div className="roles-list">
        {[...teamRoles].sort((a, b) => b.position - a.position).map((role) => (
          <button
            key={role.id}
            className={`role-item ${selectedRoleId === role.id ? 'active' : ''}`}
            onClick={() => selectRole(role)}
            type="button"
          >
            <span className="role-color-circle" style={{ background: role.color || '#8fa3b8' }} />
            <span className="role-name">{role.name}</span>
            {role.isDefault && <span className="role-default-badge">{t('roles.default', 'Default')}</span>}
          </button>
        ))}
      </div>

      {selectedRole && (
        <div className="role-editor">
          <div className="settings-field">
            <label>{t('roles.name', 'Role Name')}</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>

          <div className="settings-field">
            <label>{t('roles.color', 'Color')}</label>
            <input
              type="color"
              value={editColor}
              onChange={(e) => setEditColor(e.target.value)}
              style={{ width: 60, height: 36, padding: 2 }}
            />
          </div>

          <h3>{t('roles.permissions', 'Permissions')}</h3>
          <div className="permissions-grid">
            {PERMISSION_FLAGS.map(({ bit, label }) => (
              <label key={bit} className="permission-check">
                <input
                  type="checkbox"
                  checked={(editPermissions & bit) !== 0}
                  onChange={() => togglePermission(bit)}
                />
                {t(label)}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
            <button className="btn-primary" onClick={handleSaveRole}>
              {t('common.save', 'Save Changes')}
            </button>
            {!selectedRole.isDefault && (
              <button className="btn-danger" onClick={handleDeleteRole}>
                {t('roles.delete', 'Delete Role')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
