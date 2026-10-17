'use client';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Button } from '../ui/button';

// Scheduled mode: signed launch packets expire within about a minute, so they
// cannot be signed ahead of time. Instead this timer starts the group
// simulation at the chosen time while the page is open, and asks you to
// review, sign and send it. Nothing is signed or sent without you.
const key = (projectId: string) => 'bundle.scheduled-launch.v1:' + projectId;
function read(projectId: string) {
  try {
    const at = Number(localStorage.getItem(key(projectId)));
    return Number.isSafeInteger(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}
function write(projectId: string, at: number | null) {
  try {
    if (at) localStorage.setItem(key(projectId), String(at));
    else localStorage.removeItem(key(projectId));
  } catch {
    /* Storage is a convenience; the timer still runs for this page. */
  }
}
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};

export function ScheduledLaunchTimer({
  projectId,
  ready,
  onDue,
}: {
  projectId: string;
  ready: boolean;
  onDue: () => void;
}) {
  const [at, setAt] = useState<number | null>(() => read(projectId));
  const [input, setInput] = useState(() =>
    toLocalInput(Date.now() + 10 * 60000),
  );
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const fired = useRef<number | null>(null);
  const fire = useEffectEvent(() => {
    // One simulation per scheduled time, even if a tick lands before cleanup.
    if (fired.current === at) return;
    fired.current = at;
    write(projectId, null);
    setAt(null);
    if (!ready) {
      setNotice(
        'Scheduled time reached, but the launch is not ready to simulate. Finish the setup above, then simulate it yourself.',
      );
      return;
    }
    setNotice(
      'Scheduled time reached. The group is being simulated now. Review, sign and send it below.',
    );
    try {
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      )
        new Notification('Launch ready for your approval');
    } catch {
      /* Notifications are optional. */
    }
    onDue();
  });
  useEffect(() => {
    if (at === null) return;
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= at) fire();
    }, 1000);
    return () => clearInterval(tick);
  }, [at]);
  const remaining = at === null ? 0 : Math.max(0, at - now);
  return (
    <fieldset className="min-w-0 space-y-2 break-words">
      <legend>Scheduled launch</legend>
      <p className="text-xs text-muted-foreground">
        Pick a time and keep this page open. At that time the complete group is
        simulated and waits for your approval, signature and send. Signed
        launches expire within about a minute, so nothing is signed early.
      </p>
      {at === null && !editing ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => setEditing(true)}
        >
          Set a launch time
        </Button>
      ) : at === null ? (
        <div className="flex flex-wrap items-end gap-2">
          <label>
            Launch time (local)
            <input
              type="datetime-local"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const next = new Date(input).getTime();
              if (!Number.isFinite(next) || next <= Date.now() + 5000) {
                setNotice('Choose a time in the future.');
                return;
              }
              if (
                typeof Notification !== 'undefined' &&
                Notification.permission === 'default'
              )
                void Notification.requestPermission().catch(() => undefined);
              write(projectId, next);
              setEditing(false);
              setAt(next);
              setNow(Date.now());
              setNotice('');
            }}
          >
            Schedule launch
          </Button>
        </div>
      ) : (
        <p>
          Simulating at {new Date(at).toLocaleString()} (in{' '}
          {Math.floor(remaining / 60000)}m{' '}
          {Math.floor((remaining % 60000) / 1000)}s).{' '}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              write(projectId, null);
              setAt(null);
              setNotice('Schedule cancelled.');
            }}
          >
            Cancel schedule
          </Button>
        </p>
      )}
      {notice && <output>{notice}</output>}
    </fieldset>
  );
}
