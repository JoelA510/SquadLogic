import {
  Home,
  Users,
  User,
  UserRoundCheck,
  Shield,
  Target,
  Calendar,
  Flag,
  Map,
  CalendarOff,
  Trophy,
  ClipboardList,
  ClipboardCheck,
  Upload,
  Download,
  PieChart,
  BarChart3,
  History,
  Settings,
  Lightbulb,
  ThermometerSun,
} from 'lucide-react';
import { PERMISSIONS } from './permissions.js';
import { FEATURE_FLAGS } from './featureFlags.js';

/**
 * Single source of truth for the admin navigation tree, the role-scoped
 * flat navs, and per-route breadcrumb metadata.
 *
 * - `permission`: hides the item unless `usePermission().can(permission)`.
 * - `feature`: hides the item unless `useFeatures().isEnabled(feature)`.
 * - `badge`: key into the counts returned by `useNavBadges`.
 * - `alert`: render the badge in the warning tone.
 */
export const NAV = [
  { type: 'item', id: 'home', label: 'Home', icon: Home, path: '/' },
  {
    type: 'group',
    id: 'people',
    label: 'People',
    items: [
      {
        id: 'players',
        label: 'Players',
        icon: User,
        path: '/players',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
        badge: 'players',
      },
      {
        id: 'coaches',
        label: 'Coaches',
        icon: UserRoundCheck,
        path: '/coaches',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
        badge: 'coaches',
      },
      {
        id: 'teams',
        label: 'Teams & Rosters',
        icon: Shield,
        path: '/teams',
        permission: PERMISSIONS.VIEW_ALL_TEAMS,
        badge: 'teams',
      },
      {
        id: 'team-builder',
        label: 'Team Builder',
        icon: Target,
        path: '/teams/builder',
        permission: PERMISSIONS.MANAGE_ALL_TEAMS,
      },
      {
        id: 'practice-preferences',
        label: 'Practice Preferences',
        icon: UserRoundCheck,
        path: '/coaches/practice-preferences',
        permission: PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
      },
    ],
  },
  {
    type: 'group',
    id: 'scheduling',
    label: 'Scheduling',
    items: [
      {
        id: 'practices',
        label: 'Practices',
        icon: Calendar,
        path: '/schedule/practice',
        permission: PERMISSIONS.VIEW_SCHEDULE,
      },
      {
        id: 'games',
        label: 'Games',
        icon: Flag,
        path: '/schedule/game',
        permission: PERMISSIONS.VIEW_SCHEDULE,
      },
      {
        id: 'fields',
        label: 'Fields & Venues',
        icon: Map,
        path: '/fields',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'blackouts',
        label: 'Blackout Dates',
        icon: CalendarOff,
        path: '/scheduling/blackouts',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'practice-lighting',
        label: 'Practice Lighting',
        icon: Lightbulb,
        path: '/schedule/practice-lighting',
        permission: PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
      },
      {
        id: 'heat-forecast',
        label: 'Heat Forecast',
        icon: ThermometerSun,
        path: '/schedule/heat',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
        feature: FEATURE_FLAGS.HEAT_FORECAST,
      },
    ],
  },
  {
    type: 'group',
    id: 'competition',
    label: 'Competition',
    items: [
      { id: 'standings', label: 'Standings', icon: Trophy, path: '/standings' },
      {
        id: 'scores',
        label: 'Scores & Results',
        icon: Flag,
        path: '/scores',
        permission: PERMISSIONS.MANAGE_SCHEDULE,
      },
    ],
  },
  {
    type: 'group',
    id: 'registration',
    label: 'Registration',
    items: [
      {
        id: 'forms',
        label: 'Forms',
        icon: ClipboardList,
        path: '/admin/forms',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'compliance',
        label: 'Compliance',
        icon: ClipboardCheck,
        path: '/admin/compliance',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
        badge: 'complianceOpen',
        alert: true,
      },
    ],
  },
  {
    type: 'group',
    id: 'data',
    label: 'Data',
    items: [
      {
        id: 'import',
        label: 'Import',
        icon: Upload,
        path: '/import',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'exports',
        label: 'Exports',
        icon: Download,
        path: '/exports',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
    ],
  },
  {
    type: 'group',
    id: 'insights',
    label: 'Insights',
    items: [
      {
        id: 'analytics',
        label: 'Analytics',
        icon: PieChart,
        path: '/admin/analytics',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'reports',
        label: 'Reports',
        icon: BarChart3,
        path: '/admin/reports',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
    ],
  },
  {
    type: 'group',
    id: 'admin',
    label: 'Administration',
    items: [
      {
        id: 'members',
        label: 'Members & Roles',
        icon: Users,
        path: '/admin/members',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
      {
        id: 'audit',
        label: 'Audit Log',
        icon: History,
        path: '/admin/audit-logs',
        permission: PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: Settings,
        path: '/settings',
        permission: PERMISSIONS.MANAGE_ORGANIZATION,
      },
    ],
  },
];

/** Flat navigation for non-admin roles. */
export const ROLE_NAV = {
  coach: [
    { id: 'home', label: 'My Dashboard', icon: Home, path: '/' },
    { id: 'teams', label: 'My Team', icon: Shield, path: '/teams' },
    { id: 'practices', label: 'Practices', icon: Calendar, path: '/schedule/practice' },
    { id: 'games', label: 'Game Schedule', icon: Flag, path: '/schedule/game' },
    { id: 'standings', label: 'Standings', icon: Trophy, path: '/standings' },
    {
      id: 'practice-preferences',
      label: 'Practice Preferences',
      icon: UserRoundCheck,
      path: '/coaches/practice-preferences',
    },
    {
      id: 'practice-lighting',
      label: 'Practice Lighting',
      icon: Lightbulb,
      path: '/schedule/practice-lighting',
    },
  ],
  parent: [
    { id: 'home', label: 'My Dashboard', icon: Home, path: '/' },
    { id: 'games', label: 'Schedule', icon: Flag, path: '/schedule/game' },
    { id: 'standings', label: 'Standings', icon: Trophy, path: '/standings' },
  ],
};
ROLE_NAV.player = ROLE_NAV.parent;
// Staff share the coach nav minus the preference and lighting pages: staff hold
// no coach record, no REQUEST_PRACTICE_PREFERENCE and no
// REQUEST_PRACTICE_LIGHTING_OVERRIDE (flat items are not permission-filtered).
ROLE_NAV.staff = ROLE_NAV.coach.filter(
  (item) => item.id !== 'practice-preferences' && item.id !== 'practice-lighting'
);

/** path -> { label, groupLabel } for breadcrumbs / PageHeader. */
export const ROUTE_META = {};
NAV.forEach((node) => {
  if (node.type === 'item') {
    ROUTE_META[node.path] = { label: node.label, groupLabel: null };
  } else {
    node.items.forEach((item) => {
      ROUTE_META[item.path] = { label: item.label, groupLabel: node.label };
    });
  }
});
// Routes that are not in the primary nav
ROUTE_META['/account'] = { label: 'Account', groupLabel: null };
ROUTE_META['/setup'] = { label: 'Season Setup', groupLabel: null };
ROUTE_META['/setup/features'] = { label: 'Choose your tools', groupLabel: 'Season Setup' };
ROUTE_META['/workflow'] = { label: 'Pipeline', groupLabel: 'Data' };

/**
 * Routes whose pages use the full-bleed <Page> scaffold (pinned header +
 * internal scroll). All other routes are rendered inside DashboardLayout's
 * legacy padded scroll wrapper until they are restyled.
 */
export const FULL_BLEED_ROUTES = new Set([
  '/',
  '/players',
  '/players/:playerId',
  '/teams/builder',
  '/scheduling/blackouts',
  '/scores',
  '/exports',
  '/admin/members',
  '/settings',
  '/coaches/practice-preferences',
  '/schedule/practice-lighting',
  '/schedule/heat',
]);
