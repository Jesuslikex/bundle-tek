'use client';

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { projectIdValid, type WorkspaceProject } from '@/lib/workspace-project';
import {
  OwnedProjectReadError,
  readOwnedProjectResponse,
} from '@/lib/owned-project-read';

type StopReason = 'superseded' | 'blocked' | 'provider-unmounted';
type Owner = {
  controller: AbortController;
  stop: (reason: StopReason) => void;
};
type Navigation = {
  blocked: boolean;
  claim: (owner: Owner) => boolean;
  release: (controller: AbortController) => void;
  requestOpen: (
    controller: AbortController,
    project: WorkspaceProject,
  ) => boolean;
};
const Context = createContext<Navigation | null>(null);

export function RecoveryProjectNavigationProvider({
  onOpen,
  blocked = false,
  children,
}: {
  onOpen: (project: WorkspaceProject) => void;
  blocked?: boolean;
  children: ReactNode;
}) {
  const latest = useRef({ onOpen, blocked });
  const active = useRef<Owner | null>(null);
  useLayoutEffect(() => {
    latest.current = { onOpen, blocked };
    if (blocked) active.current?.stop('blocked');
  }, [onOpen, blocked]);
  useLayoutEffect(
    () => () => {
      active.current?.stop('provider-unmounted');
      active.current = null;
    },
    [],
  );
  const claim = useCallback((owner: Owner) => {
    if (latest.current.blocked || owner.controller.signal.aborted) return false;
    active.current?.stop('superseded');
    active.current = owner;
    return true;
  }, []);
  const release = useCallback((controller: AbortController) => {
    if (active.current?.controller === controller) active.current = null;
  }, []);
  const requestOpen = useCallback(
    (controller: AbortController, project: WorkspaceProject) => {
      if (
        latest.current.blocked ||
        controller.signal.aborted ||
        active.current?.controller !== controller
      )
        return false;
      latest.current.onOpen(project);
      return true;
    },
    [],
  );
  const context = useMemo(
    () => ({ blocked, claim, release, requestOpen }),
    [blocked, claim, release, requestOpen],
  );
  return <Context.Provider value={context}>{children}</Context.Provider>;
}

export function RecoveryProjectOpenButton({
  projectId,
}: {
  projectId: string;
}) {
  const context = useContext(Context);
  return context ? (
    <ProjectOpen key={projectId} projectId={projectId} context={context} />
  ) : null;
}

function ProjectOpen({
  projectId,
  context,
}: {
  projectId: string;
  context: Navigation;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const active = useRef<{
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const release = context.release;
  const stop = useCallback(
    (notice?: string) => {
      generation.current += 1;
      const current = active.current;
      active.current = null;
      if (current) {
        if (current.deadline !== null) clearTimeout(current.deadline);
        current.controller.abort();
        release(current.controller);
      }
      if (mounted.current) {
        setBusy(false);
        setNeedsSignIn(false);
        if (notice !== undefined) setMessage(notice);
      }
    },
    [release],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, [stop]);

  async function open() {
    stop('');
    if (context.blocked) {
      setMessage(
        'Project navigation is busy. Wait for the current work to finish, then try again.',
      );
      return;
    }
    if (!projectIdValid(projectId)) {
      setMessage(
        'The saved project reference is unavailable. Keep the original recovery reference.',
      );
      return;
    }
    const controller = new AbortController();
    const current = generation.current;
    active.current = { controller, deadline: null };
    if (
      !context.claim({
        controller,
        stop(reason) {
          stop(
            reason === 'superseded'
              ? 'Project read cancelled because another saved project was requested. No project was opened by this read.'
              : reason === 'blocked'
                ? 'Project read cancelled because project navigation is busy. Try again after the current work finishes.'
                : undefined,
          );
        },
      })
    ) {
      stop(
        'Project navigation is busy. Try again after the current work finishes.',
      );
      return;
    }
    setBusy(true);
    setNeedsSignIn(false);
    active.current.deadline = setTimeout(() => {
      if (current === generation.current)
        stop(
          'Opening the saved project took too long. No project was opened by this read. Try again manually.',
        );
    }, 15_000);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        },
      );
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      ) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const project = await readOwnedProjectResponse(
        response,
        projectId,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      )
        return;
      if (project.archived) {
        setMessage(
          'This current saved project is archived. It was not opened or restored. Keep the original recovery reference and inspect Archived projects manually.',
        );
        return;
      }
      if (
        context.requestOpen(controller, project) &&
        mounted.current &&
        current === generation.current &&
        !controller.signal.aborted
      )
        setMessage(
          'Project open requested. Resolve any unsaved-draft prompt before continuing. The current saved project may differ from the original review; no review was selected or approval renewed.',
        );
    } catch (error) {
      if (
        controller.signal.aborted ||
        current !== generation.current ||
        !mounted.current
      )
        return;
      if (error instanceof OwnedProjectReadError && error.status === 401) {
        setNeedsSignIn(true);
        setMessage('Sign in to open this saved project, then retry manually.');
      } else if (
        error instanceof OwnedProjectReadError &&
        error.status === 404
      ) {
        setMessage(
          'The saved project was not found for this account. Keep the original recovery reference; no replacement project was created.',
        );
      } else {
        setMessage(
          'The current saved project is unavailable. Keep the original recovery reference and try again manually.',
        );
      }
    } finally {
      if (current === generation.current && mounted.current) {
        if (
          active.current?.deadline !== null &&
          active.current?.deadline !== undefined
        )
          clearTimeout(active.current.deadline);
        release(controller);
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className="min-w-0 space-y-2">
      <p>
        Opens the current saved project, which may differ from the original
        review. This does not select a review, renew approval or authorize a
        wallet action.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="h-auto min-h-11 max-w-full whitespace-normal"
          disabled={busy || context.blocked}
          onClick={() => void open()}
        >
          Open current saved project
        </Button>
        {busy && (
          <Button
            variant="outline"
            className="h-auto min-h-11 whitespace-normal"
            onClick={() =>
              stop(
                'Project read cancelled. No project was opened by this read.',
              )
            }
          >
            Cancel project read
          </Button>
        )}
      </div>
      {context.blocked && (
        <p>
          Project navigation is busy. Wait for the current work to finish before
          opening a saved project.
        </p>
      )}
      {busy && <output>Reading the current saved project…</output>}
      {message && <output className="block break-words">{message}</output>}
      {needsSignIn && (
        <a
          className="inline-flex min-h-11 items-center underline"
          href="/sign-in"
          target="_blank"
          rel="noopener noreferrer"
        >
          Sign in (opens a new tab)
        </a>
      )}
    </div>
  );
}
