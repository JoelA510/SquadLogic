import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, FlaskConical } from 'lucide-react';
import { NAV, ROLE_NAV } from '../../constants/navigation.js';
import { usePermission } from '../../hooks/usePermission.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useNavBadges } from '../../hooks/useNavBadges.js';
import { useFeatures } from '../../hooks/useFeatures.js';
import { IS_MOCK_MODE } from '../../config.js';

function NavItem({ item, collapsed = false, badge = null, onNavigate = undefined }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
    >
      <Icon size={17} className="ni-icon" aria-hidden="true" />
      <span className="ni-label">{item.label}</span>
      {badge != null && <span className={`ni-badge ${item.alert ? 'alert' : ''}`}>{badge}</span>}
    </NavLink>
  );
}

NavItem.propTypes = {
  item: PropTypes.object.isRequired,
  collapsed: PropTypes.bool,
  badge: PropTypes.node,
  onNavigate: PropTypes.func,
};

/**
 * Nested collapsible navigation (admin) or flat role nav (coach/parent).
 * Desktop: 256px ↔ 60px collapse, persisted. Mobile (<900px): off-canvas
 * drawer opened from the TopBar hamburger.
 */
export default function SideNav({
  collapsed = false,
  onToggleCollapsed,
  mobileOpen = false,
  onMobileClose = undefined,
}) {
  const { can, role } = usePermission();
  const { user, isImpersonating } = useAuth();
  const badges = useNavBadges();
  const { isEnabled } = useFeatures();
  const location = useLocation();

  // Under role preview (impersonation) the nav scopes to the previewed role.
  const effectiveRole = isImpersonating ? user?.profile?.role || role : role;

  const [openGroups, setOpenGroups] = useState(() => {
    const init = {};
    NAV.forEach((node) => {
      if (node.type === 'group') init[node.id] = true;
    });
    return init;
  });

  // Make sure the group containing the active route is open after a
  // navigation (render-phase state adjustment, not an effect).
  const activeGroup = NAV.find(
    (node) => node.type === 'group' && node.items.some((item) => location.pathname === item.path)
  );
  const [lastPath, setLastPath] = useState(location.pathname);
  if (location.pathname !== lastPath) {
    setLastPath(location.pathname);
    if (activeGroup && !openGroups[activeGroup.id]) {
      setOpenGroups((open) => ({ ...open, [activeGroup.id]: true }));
    }
  }

  const handleNavigate = () => {
    if (window.innerWidth < 900) onMobileClose?.();
  };

  const isAdminNav =
    effectiveRole !== 'coach' && effectiveRole !== 'parent' && effectiveRole !== 'player';
  const flatItems = isAdminNav ? null : ROLE_NAV[effectiveRole] || ROLE_NAV.parent;

  const visible = (item) =>
    (!item.permission || can(item.permission)) && (!item.feature || isEnabled(item.feature));

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-[65] min-[900px]:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`nav ${collapsed ? 'collapsed' : ''}`}
        data-mobile-open={mobileOpen ? 'true' : undefined}
      >
        <nav className="nav-scroll" aria-label="Primary">
          {flatItems ? (
            <>
              {!collapsed && (
                <div className="nav-group-label" style={{ pointerEvents: 'none' }}>
                  {effectiveRole === 'coach' || effectiveRole === 'staff' ? 'Coach' : 'Family'}
                </div>
              )}
              {flatItems.map((item) => (
                <NavItem
                  key={item.id}
                  item={item}
                  collapsed={collapsed}
                  onNavigate={handleNavigate}
                />
              ))}
            </>
          ) : (
            NAV.map((node) => {
              if (node.type === 'item') {
                return (
                  <NavItem
                    key={node.id}
                    item={node}
                    collapsed={collapsed}
                    onNavigate={handleNavigate}
                  />
                );
              }
              const items = node.items.filter(visible);
              if (items.length === 0) return null;
              const isOpen = openGroups[node.id];
              const hasActive = items.some((item) => location.pathname === item.path);
              return (
                <div className="nav-group" key={node.id}>
                  {collapsed ? (
                    <div
                      style={{ height: 1, background: 'var(--border-soft)', margin: '6px 8px' }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`nav-group-label ${isOpen ? '' : 'closed'}`}
                      aria-expanded={isOpen}
                      onClick={() =>
                        setOpenGroups((open) => ({ ...open, [node.id]: !open[node.id] }))
                      }
                    >
                      {node.label}
                      {hasActive && !isOpen && (
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            background: 'var(--primary)',
                          }}
                        />
                      )}
                      <ChevronDown size={14} className="chev" aria-hidden="true" />
                    </button>
                  )}
                  {(isOpen || collapsed) && (
                    <div className="nav-children">
                      {items.map((item) => (
                        <NavItem
                          key={item.id}
                          item={item}
                          collapsed={collapsed}
                          badge={item.badge ? badges[item.badge] : null}
                          onNavigate={handleNavigate}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {IS_MOCK_MODE && (
            <a
              href="https://github.com/JoelA510/SquadLogic/blob/main/docs/operations/ENVIRONMENT.md"
              target="_blank"
              rel="noopener noreferrer"
              className="nav-item"
              style={{ marginTop: 12, color: 'var(--warning-text)' }}
              title="Mock Mode Active"
            >
              <FlaskConical size={16} className="ni-icon" aria-hidden="true" />
              <span className="ni-label">Mock Mode Active</span>
            </a>
          )}
        </nav>
        <div className="nav-foot">
          <button
            type="button"
            className="nav-item"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            style={{ margin: 0 }}
          >
            {collapsed ? (
              <ChevronRight size={18} className="ni-icon" aria-hidden="true" />
            ) : (
              <ChevronLeft size={18} className="ni-icon" aria-hidden="true" />
            )}
            <span className="ni-label">Collapse</span>
          </button>
        </div>
      </aside>
    </>
  );
}

SideNav.propTypes = {
  collapsed: PropTypes.bool,
  onToggleCollapsed: PropTypes.func,
  mobileOpen: PropTypes.bool,
  onMobileClose: PropTypes.func,
};
