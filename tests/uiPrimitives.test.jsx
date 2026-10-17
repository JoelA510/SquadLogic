import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import Badge from '../frontend/src/components/ui/Badge.jsx';
import Toggle from '../frontend/src/components/ui/Toggle.jsx';
import Tabs from '../frontend/src/components/ui/Tabs.jsx';
import Modal from '../frontend/src/components/ui/Modal.jsx';
import Dropdown from '../frontend/src/components/ui/Dropdown.jsx';
import Avatar from '../frontend/src/components/ui/Avatar.jsx';
import ToastHost, { useToast } from '../frontend/src/components/ui/ToastHost.jsx';
import Button from '../frontend/src/components/ui/Button.jsx';
import { ThemeProvider, useTheme } from '../frontend/src/contexts/ThemeContext.jsx';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Badge', () => {
  it('applies tone classes', () => {
    render(<Badge tone="success">Paid</Badge>);
    const badge = screen.getByText('Paid');
    expect(badge.className).toContain('badge');
    expect(badge.className).toContain('success');
  });
});

describe('Button', () => {
  it('maps variants to .btn classes and keeps its public API', () => {
    const onClick = vi.fn();
    render(
      <Button variant="secondary" size="sm" onClick={onClick}>
        Export
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Export' });
    expect(button.className).toContain('btn-default');
    expect(button.className).toContain('sm');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables and shows a spinner while loading', () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('Toggle', () => {
  it('is an accessible switch and reports the next value', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Player rating" />);
    const toggle = screen.getByRole('switch', { name: 'Player rating' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'guardians', label: 'Guardians' },
    { id: 'schedule', label: 'Schedule' },
  ];

  it('marks the active tab and switches on click', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="overview" onChange={onChange} label="Player record" />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Guardians' }));
    expect(onChange).toHaveBeenCalledWith('guardians');
  });

  it('supports arrow-key navigation with wrap-around', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="overview" onChange={onChange} label="Player record" />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('schedule');
  });

  it('keeps a disabled tab in the strip, named by its reason, and out of reach', () => {
    const onChange = vi.fn();
    render(
      <>
        <Tabs
          tabs={[tabs[0], { ...tabs[1], disabled: true, describedBy: 'guardians-reason' }, tabs[2]]}
          activeTab="overview"
          onChange={onChange}
          label="Player record"
        />
        <p id="guardians-reason">No guardians on file.</p>
      </>
    );
    const guardians = screen.getByRole('tab', { name: 'Guardians' });
    expect(guardians).toBeDisabled();
    expect(guardians).toHaveAccessibleDescription('No guardians on file.');

    fireEvent.click(guardians);
    expect(onChange).not.toHaveBeenCalled();
    // ArrowRight from Overview skips Guardians.
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('schedule');
    expect(onChange).not.toHaveBeenCalledWith('guardians');
  });

  it('does not report a change when a key lands on the selected tab', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        tabs={[tabs[0], { ...tabs[1], disabled: true }]}
        activeTab="overview"
        onChange={onChange}
        label="Player record"
      />
    );
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Modal', () => {
  it('renders a dialog when open and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Merge divisions">
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByRole('dialog', { name: 'Merge divisions' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>Body</p>
      </Modal>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Dropdown', () => {
  it('opens via the trigger and fires item onSelect', () => {
    const onSelect = vi.fn();
    render(
      <Dropdown
        renderTrigger={({ toggle, triggerProps }) => (
          <button type="button" onClick={toggle} {...triggerProps}>
            Open menu
          </button>
        )}
        items={[{ id: 'export', label: 'Export CSV', onSelect }]}
      />
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export CSV' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('Avatar', () => {
  it('renders initials from the name', () => {
    render(<Avatar name="Jordan Alvarez" />);
    expect(screen.getByTitle('Jordan Alvarez')).toHaveTextContent('JA');
  });
});

describe('ToastHost', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast('Players saved', 'success')}>
        Notify
      </button>
    );
  }

  it('shows and auto-dismisses toasts', () => {
    vi.useFakeTimers();
    render(
      <ToastHost>
        <Trigger />
      </ToastHost>
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Notify' }));
    });
    expect(screen.getByText('Players saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Players saved')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('ThemeContext theme mode', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  function ThemeProbe() {
    const { themeMode, toggleThemeMode } = useTheme();
    return (
      <button type="button" onClick={toggleThemeMode}>
        mode:{themeMode}
      </button>
    );
  }

  it('defaults to light, toggles to dark, and persists as sl-theme', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    const probe = screen.getByRole('button');
    expect(probe).toHaveTextContent('mode:light');
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(probe);
    expect(probe).toHaveTextContent('mode:dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('sl-theme')).toBe('dark');
  });

  it('restores a stored dark preference', () => {
    localStorage.setItem('sl-theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );
    expect(screen.getByRole('button')).toHaveTextContent('mode:dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
