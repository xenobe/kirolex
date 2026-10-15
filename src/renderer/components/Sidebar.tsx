import React, { useState, useRef, useEffect } from 'react';
import {
  DndContext,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Session } from '../App';
import { IconLogs, IconRobot, IconWorkspaceFolder } from './Icons';

type SessionStatus = 'idle' | 'streaming' | 'unread' | 'dormant' | 'connecting' | 'warm' | 'alert' | 'rebuilding';

const UNASSIGNED = '__unassigned__';
const ARCHIVED = '__archived__';

// --- Small inline icons matching the reference (outline, currentColor) -------
const ProjectFolderIcon = () => (
  <svg className="pg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const KebabIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
  </svg>
);
const PlusSquareIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

interface SidebarProps {
  sessions: Session[];
  projects: string[];
  currentSessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected';
  streamingSessionIds: string[];
  attachedSessionIds: string[];
  busyBySession?: Record<string, string>;  connectingSessionIds: string[];
  unreadSessionIds: string[];
  executorCap?: number;
  onNewSession: () => void;
  onCreateProject: (name: string) => void;
  /** Move `name` to `target`'s position in the project order (user-adjustable). */
  onReorderProjects?: (name: string, target: string) => void;
  onNewSessionInProject: (project: string) => void;
  onRenameProject: (oldName: string, newName: string) => void;
  onDeleteProject: (name: string) => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  /** Force-rebuild this chat's backend context from the saved transcript. */
  onRebuildContext?: (id: string, mode?: 'snapshot' | 'full') => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  /** 1-based grid position per session (0 = not in the split), so the sidebar
   *  can highlight the visible chats in grid order. */
  splitOrder?: (id: string) => number;
  onToggleSplit?: (id: string) => void;
  onAssignProject: (sessionId: string, projectId: string) => void;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onSettings: () => void;
  workspaceOpen: boolean;
  onOpenWorkspace: () => void;
  onOpenLogs: () => void;
  onOpenMemory: () => void;
  /** Agent config is a global file, so its trigger lives here, not per chat. */
  onOpenAgentConfig: () => void;
}

// Draggable + selectable session row.
const SessionItem: React.FC<{
  session: Session;
  isActive: boolean;
  sessionStatus: SessionStatus;
  busyReason?: string | null;
  onSwitch: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  /** 1-based position of this chat in the split grid; 0 = not shown. */
  splitOrder?: number;
  onToggleSplit?: (id: string) => void;
}> = ({ session, isActive, sessionStatus, busyReason, onSwitch, onContextMenu, onDelete, splitOrder = 0, onToggleSplit }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const dotTitle =
    busyReason === 'reconfiguring' ? '占用中：正在切换模型 / Agent…'
    : busyReason === 'attaching' ? '占用中：正在连接 / 重新连接后端…'
    : busyReason === 'priming' ? '占用中：正在重建历史上下文（会重试到完成；按 Stop 可放弃）'
    : busyReason === 'prime-pending' ? '占用中：历史上下文缺失，重建即将/正在进行；新消息会排队'
    : busyReason === 'turn' ? '占用中：回合进行中…'
    : sessionStatus === 'streaming' ? 'Working…'
    : sessionStatus === 'connecting' ? 'Connecting…'
    : sessionStatus === 'unread' ? 'Unread reply'
    : sessionStatus === 'warm' ? 'Live — ready (background)'
    : sessionStatus === 'alert' ? 'Not connected — select to activate'
    : sessionStatus === 'dormant' ? 'Archived — inactive'
    : 'Live — idle';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-item ${isActive ? 'active' : ''}${splitOrder > 0 ? ' in-split' : ''}`}
      // One gesture only: clicking a chat opens it (and, in split view, puts it in
      // the next free slot). "Add without switching focus" was a made-up gesture
      // with no real use case; removing a chat lives on the pane's ✕ / right-click.
      onClick={() => onSwitch(session.id)}
      onContextMenu={(e) => onContextMenu(e, session.id)}
      {...attributes}
      {...listeners}
    >
      {splitOrder > 0 && (
        <span
          className="session-split-order"
          title={`分屏第 ${splitOrder} 格 · 右键或该格的 ✕ 可移除`}
        >{splitOrder}</span>
      )}
      {session.pinned && <span className="session-pin" title="Pinned">📌</span>}
      <span className={`session-dot ${sessionStatus}`} title={dotTitle}>
        {sessionStatus === 'streaming' && <><span /><span /><span /></>}
        {/* Rotating arc: unmistakably "work in progress on the history", and not
            the green idle light nor the green reply animation. */}
        {sessionStatus === 'rebuilding' && <span className="session-dot-arc" />}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.title}
      </span>
      <button className="session-delete-btn" onClick={(e) => onDelete(e, session.id)} title="Delete">
        ✕
      </button>
    </div>
  );
};

// A project group. Real projects are drop targets for write-once assignment;
// the Unassigned bucket is NOT (you cannot un-assign — design §6.4).
const ProjectGroup: React.FC<{
  name: string;
  projectKey: string;
  isDropTarget: boolean;
  actionable: boolean; // real projects get kebab + new-chat; Unassigned does not
  showCount?: boolean; // hide the count badge (e.g. for the Archived group)
  sessions: Session[];
  collapsed: boolean;
  currentSessionId: string | null;
  statusFor: (id: string) => SessionStatus;
  busyFor: (id: string) => string | null;
  onToggle: (key: string) => void;
  onSwitch: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: (project: string) => void;
  onProjectMenu: (e: React.MouseEvent, project: string) => void;
  splitOrder?: (id: string) => number;
  onToggleSplit?: (id: string) => void;
}> = ({ name, projectKey, isDropTarget, actionable, showCount = true, sessions, collapsed, currentSessionId, statusFor, busyFor, onToggle, onSwitch, onContextMenu, onDelete, onNewChat, onProjectMenu, splitOrder = () => 0, onToggleSplit }) => {
  const { setNodeRef, isOver } = useDroppable({ id: `project:${projectKey}`, disabled: !isDropTarget });
  // Reorder drag lives on a DEDICATED grip, not the whole header: putting the drag
  // listeners on the header itself would swallow the collapse click, the kebab and
  // the new-chat button. Only real projects are reorderable (the Unassigned and
  // Archived buckets are fixed in place, always last).
  const {
    attributes: gripAttrs,
    listeners: gripListeners,
    setNodeRef: setGripRef,
    isDragging: gripDragging,
  } = useDraggable({ id: `projorder:${name}`, disabled: !actionable });

  return (
    <div ref={setNodeRef} className="project-group">
      <div
        className={`project-header ${isOver && isDropTarget ? 'folder-drop-target' : ''} ${gripDragging ? 'project-header-dragging' : ''}`}
        onClick={() => onToggle(projectKey)}
      >
        {actionable && (
          <span
            ref={setGripRef}
            className="project-drag-handle"
            title="拖动以调整项目顺序"
            onClick={(e) => e.stopPropagation()}
            {...gripAttrs}
            {...gripListeners}
          >
            ⋮⋮
          </span>
        )}
        <span className="folder-arrow">{collapsed ? '▶' : '▼'}</span>
        <ProjectFolderIcon />
        <span className="folder-name">{name}</span>
        {showCount && <span className="project-count">{sessions.length}</span>}
        {actionable && (
          <>
            <button
              className="project-action-btn"
              title="Project options"
              onClick={(e) => { e.stopPropagation(); onProjectMenu(e, name); }}
            >
              <KebabIcon />
            </button>
            <button
              className="project-action-btn"
              title="New chat in project"
              onClick={(e) => { e.stopPropagation(); onNewChat(name); }}
            >
              <PlusSquareIcon />
            </button>
          </>
        )}
      </div>
      {!collapsed && (
        <div className="folder-children">
          {actionable && (
            <div
              className="project-newchat"
              onClick={(e) => { e.stopPropagation(); onNewChat(name); }}
            >
              <PlusSquareIcon />
              <span>New chat in project</span>
            </div>
          )}
          <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                isActive={s.id === currentSessionId}
                sessionStatus={statusFor(s.id)}
                busyReason={busyFor(s.id)}
                onSwitch={onSwitch}
                onContextMenu={onContextMenu}
                onDelete={(e, id) => { e.stopPropagation(); onDelete(id); }}
                splitOrder={splitOrder(s.id)}
                onToggleSplit={onToggleSplit}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  projects,
  currentSessionId,
  status,
  streamingSessionIds,
  attachedSessionIds,
  busyBySession,
  connectingSessionIds,
  unreadSessionIds,
  executorCap,
  onNewSession,
  onCreateProject,
  onReorderProjects,
  onNewSessionInProject,
  onRenameProject,
  onDeleteProject,
  onSwitchSession,
  onDeleteSession,
  onRebuildContext,
  onRenameSession,
  onTogglePin,
  splitOrder = () => 0,
  onToggleSplit,
  onAssignProject,
  onMoveSession,
  onArchiveSession,
  onSettings,
  workspaceOpen,
  onOpenWorkspace,
  onOpenLogs,
  onOpenMemory,
  onOpenAgentConfig,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);
  const [renamePopup, setRenamePopup] = useState<{ id: string; value: string } | null>(null);
  const [assignPopup, setAssignPopup] = useState<{ sessionId: string } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; project: string } | null>(null);
  const [projectRenamePopup, setProjectRenamePopup] = useState<{ project: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const newProjectRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  useEffect(() => {
    const handler = () => setProjectMenu(null);
    if (projectMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [projectMenu]);

  useEffect(() => {
    if (creatingProject) newProjectRef.current?.focus();
  }, [creatingProject]);

  // Per-session dot priority: streaming (working, any session) > connecting >
  // unread (finished in background) > live (ONLY the current session, and only
  // once its executor is attached) > dormant. Solid green never lingers on an
  // unselected chat — background activity shows as streaming/unread instead.
  const busyFor = (id: string): string | null => busyBySession?.[id] || null;
  const statusFor = (id: string): SessionStatus => {
    const busy = busyBySession?.[id];
    // Rebuild states are checked FIRST and get their own light. Two reasons:
    // 'prime-pending' used to fall through to idle/warm, i.e. a STATIC GREEN dot
    // on a chat that is actually locked and owes a rebuild -- the one state that
    // must never look "connected and idle". And 'priming' previously borrowed the
    // normal turn animation, so a rebuild was indistinguishable from a reply.
    if (busy === 'priming' || busy === 'prime-pending') return 'rebuilding';
    if (streamingSessionIds.includes(id)) return 'streaming';
    // Backend occupancy reported by main: the dot must show it even when this
    // renderer has no local streaming/connecting state for that session.
    if (busy === 'turn') return 'streaming';
    if (busy === 'reconfiguring' || busy === 'attaching') return 'connecting';
    if (connectingSessionIds.includes(id)) return 'connecting';
    if (unreadSessionIds.includes(id)) return 'unread';
    const attached = attachedSessionIds.includes(id);
    if (id === currentSessionId && attached) return 'idle';   // focused + live
    if (attached) return 'warm';                              // background, live/ready
    // Not attached: an archived chat is deliberately inert (neutral). A pending
    // fork/new chat has no backend executor until its first message — that is
    // expected, not an error, so show it neutral (dormant) rather than red alert.
    if (String(id).startsWith('pending_')) return 'dormant';
    // Any other not-yet-attached chat is a NORMAL idle state: it attaches on open
    // (or via background eager-warm), so it must not look broken. Show it neutral
    // (dormant/grey), never the alarming orange 'alert' — attached chats are the
    // only ones that go green (warm/idle).
    return 'dormant';
  };

  const handleContextMenu = (e: React.MouseEvent, targetId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, targetId });
  };

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Drag a session onto a project header (or onto any session in a project) =
  // Drag to MOVE a session between projects (or onto Unassigned to unassign).
  // Executor-reset happens backend-side; a no-op (same project) is ignored.
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const sessionId = active.id as string;
    const overId = over.id as string;

    // PROJECT REORDER (grip drag). Dropping onto the Unassigned or Archived bucket
    // is refused on purpose: those two groups are rendered after the project list
    // and must stay last, so there is no valid position "below" them for a project.
    if (sessionId.startsWith('projorder:')) {
      const moved = sessionId.slice('projorder:'.length);
      let target: string | null = null;
      if (overId.startsWith('project:')) {
        const key = overId.slice('project:'.length);
        if (key === UNASSIGNED || key === ARCHIVED) return; // never below the buckets
        target = key;
      } else {
        // Dropped on a session row: use that row's project. A row in the
        // Unassigned bucket has no project -> no valid target.
        const row = sessions.find((x) => x.id === overId);
        if (!row || !row.projectId) return;
        target = row.projectId;
      }
      if (!target || target === moved) return;
      onReorderProjects?.(moved, target);
      return;
    }

    // Resolve the destination project from either a project droppable (incl.
    // the Unassigned bucket -> null) or a session row (use that row's project).
    let targetProject: string | null = null;
    let explicitDrop = false;
    if (overId.startsWith('project:')) {
      const key = overId.slice('project:'.length);
      targetProject = key === UNASSIGNED ? null : key;
      explicitDrop = true;
    } else {
      const row = sessions.find((x) => x.id === overId);
      if (row) { targetProject = row.projectId || null; explicitDrop = true; }
    }
    if (!explicitDrop) return;
    const dragged = sessions.find((x) => x.id === sessionId);
    if (!dragged || dragged.id.startsWith('pending_')) return;
    // An archived chat must only leave the archive through the explicit
    // Unarchive action; a stray drag must never silently unarchive it (the
    // backend move handler clears the archived flag).
    if (dragged.archived) return;
    if ((dragged.projectId ?? null) === targetProject) return; // no change
    onMoveSession(sessionId, targetProject);
  };

  // Pinned sessions float to the top of their group.
  const sortForDisplay = (arr: Session[]) =>
    [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  // Archived sessions are pulled out of the normal groups into their own
  // collapsible section; everything else groups as usual.
  const activeSessions = sessions.filter((s) => !s.archived);
  const archivedSessions = sortForDisplay(sessions.filter((s) => s.archived));

  // Display order = the ORDER OF `projects` (user-adjustable via the header grip),
  // NOT alphabetical. Projects discovered only from session records are appended
  // at the end so they still show up. The reserved bucket keys are excluded: the
  // Unassigned/Archived groups are rendered separately, always last, so a project
  // can never end up below them.
  const knownProjects = projects.filter((p) => p && p !== UNASSIGNED && p !== ARCHIVED);
  const fromSessions = (activeSessions.map((s) => s.projectId).filter(Boolean) as string[])
    .filter((p) => p !== UNASSIGNED && p !== ARCHIVED && !knownProjects.includes(p));
  const assignedProjects = Array.from(new Set([...knownProjects, ...fromSessions]));

  const unassigned = sortForDisplay(activeSessions.filter((s) => !s.projectId));

  const confirmNewProject = () => {
    if (newProjectName.trim()) onCreateProject(newProjectName.trim());
    setCreatingProject(false);
    setNewProjectName('');
  };

  const ctxSession = contextMenu ? sessions.find((s) => s.id === contextMenu.targetId) : undefined;

  const handleProjectMenu = (e: React.MouseEvent, project: string) => {
    e.preventDefault();
    setProjectMenu({ x: e.clientX, y: e.clientY, project });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-top-btns">
        <button className="new-session-btn no-drag" onClick={onNewSession}>
          + New Session
        </button>
        <button
          className="new-project-btn no-drag"
          onClick={() => { setCreatingProject(true); setNewProjectName(''); }}
          title="Create a project"
        >
          + New Project
        </button>
      </div>

      <div className="session-list">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(e) => setActiveId(e.active.id as string)}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={handleDragEnd}
        >
          {/* New project input */}
          {creatingProject && (
            <div className="project-header" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="project-icon">▣</span>
              <input
                ref={newProjectRef}
                className="session-rename-input"
                value={newProjectName}
                placeholder="Project name…"
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNewProject();
                  else if (e.key === 'Escape') { setCreatingProject(false); setNewProjectName(''); }
                }}
                onBlur={confirmNewProject}
              />
            </div>
          )}

          {/* Project groups (drop targets for write-once assignment) */}
          {assignedProjects.map((pName) => (
            <ProjectGroup
              key={pName}
              name={pName}
              projectKey={pName}
              isDropTarget
              actionable
              sessions={sortForDisplay(activeSessions.filter((s) => s.projectId === pName))}
              collapsed={collapsed.has(pName)}
              currentSessionId={currentSessionId}
              statusFor={statusFor}
            busyFor={busyFor}
              onToggle={toggle}
              onSwitch={onSwitchSession}
              onContextMenu={handleContextMenu}
              splitOrder={splitOrder}
              onToggleSplit={onToggleSplit}
              onDelete={onDeleteSession}
              onNewChat={onNewSessionInProject}
              onProjectMenu={handleProjectMenu}
            />
          ))}

          {/* Unassigned bucket — ALWAYS visible (even when empty) as a drop
              target for un-assigning a chat from a project. */}
          <ProjectGroup
            name="Unassigned"
            projectKey={UNASSIGNED}
            isDropTarget
            actionable={false}
            sessions={unassigned}
            collapsed={collapsed.has(UNASSIGNED)}
            currentSessionId={currentSessionId}
            statusFor={statusFor}
            busyFor={busyFor}
            onToggle={toggle}
            onSwitch={onSwitchSession}
            onContextMenu={handleContextMenu}
            splitOrder={splitOrder}
            onToggleSplit={onToggleSplit}
            onDelete={onDeleteSession}
            onNewChat={onNewSessionInProject}
            onProjectMenu={handleProjectMenu}
          />

          {/* Archived sessions — ALWAYS visible (even when empty), collapsed by
              default; NOT a drop target. Out of the way, not deleted. */}
          <ProjectGroup
            name="Archived"
            projectKey={ARCHIVED}
            isDropTarget={false}
            actionable={false}
            showCount={false}
            sessions={archivedSessions}
            collapsed={!collapsed.has(ARCHIVED)}
            currentSessionId={currentSessionId}
            statusFor={statusFor}
            busyFor={busyFor}
            onToggle={toggle}
            onSwitch={onSwitchSession}
            onContextMenu={handleContextMenu}
            splitOrder={splitOrder}
            onToggleSplit={onToggleSplit}
            onDelete={onDeleteSession}
            onNewChat={onNewSessionInProject}
            onProjectMenu={handleProjectMenu}
          />

          <DragOverlay dropAnimation={null}>
            {activeId && activeId.startsWith('projorder:') ? (
              <div className="session-item drag-overlay-item">
                <span className="folder-name">{activeId.slice('projorder:'.length)}</span>
              </div>
            ) : activeId ? (
              <div className="session-item drag-overlay-item">
                <span className="session-dot idle" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sessions.find((s) => s.id === activeId)?.title || 'Chat'}
                </span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Session context menu: Rename / Pin-Unpin / Delete */}
      {contextMenu && ctxSession && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          <div
            className="context-menu-item"
            onClick={() => { setRenamePopup({ id: ctxSession.id, value: ctxSession.title }); setContextMenu(null); }}
          >
            ✏️ Rename
          </div>
          <div
            className="context-menu-item"
            onClick={() => { onTogglePin(ctxSession.id); setContextMenu(null); }}
          >
            {ctxSession.pinned ? '📌 Unpin' : '📌 Pin'}
          </div>
          {/* Deliberately NOT exposed here: 「重建上下文」(snapshot / full replay).
              It is a recovery lever for internal state -- which backend holds which
              history -- and does not map to anything a user can judge from the UI; it
              still runs AUTOMATICALLY when a backend turns out to be missing this
              chat's history. 「换一个干净后端」 was here too and is now gone entirely,
              mechanism included: it only ever existed to compensate for an oversized
              image reaching a backend, which is the wrong layer to fix that.

              A 「清除历史」 entry was here too and is gone, mechanism included: it
              deleted the stored transcript AND sent a hidden `/clear`, which is both
              irreversible from a right-click menu and redundant -- resetting the
              backend context is what the user's own `/clear` message does. */}
          {!ctxSession.id.startsWith('pending_') && (
            <div
              className="context-menu-item"
              onClick={() => { onToggleSplit?.(ctxSession.id); setContextMenu(null); }}
              title="分屏显示这个会话（每个分屏都能独立输入）"
            >
              {splitOrder(ctxSession.id) > 0 ? '⇆ 从分屏移除' : '⇆ 加入分屏'}
            </div>
          )}
          {!ctxSession.id.startsWith('pending_') && (
            <>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                style={{ opacity: 0.6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', pointerEvents: 'none' }}
              >
                {ctxSession.projectId ? 'Move to project' : 'Assign to project'}
              </div>
              {projects.filter((p) => p !== ctxSession.projectId).map((p) => (
                <div
                  key={p}
                  className="context-menu-item"
                  onClick={() => { onMoveSession(ctxSession.id, p); setContextMenu(null); }}
                >
                  🏷️ {p}
                </div>
              ))}
              {ctxSession.projectId && (
                <div
                  className="context-menu-item"
                  onClick={() => { onMoveSession(ctxSession.id, null); setContextMenu(null); }}
                >
                  ⬜ Unassign
                </div>
              )}
              <div
                className="context-menu-item"
                onClick={() => { setAssignPopup({ sessionId: ctxSession.id }); setContextMenu(null); }}
              >
                ＋ New project…
              </div>
            </>
          )}
          {!ctxSession.id.startsWith('pending_') && (
            <>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                onClick={() => { onArchiveSession(ctxSession.id, !ctxSession.archived); setContextMenu(null); }}
              >
                {ctxSession.archived ? '♻️ Unarchive' : '🗄️ Archive'}
              </div>
            </>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => { onDeleteSession(ctxSession.id); setContextMenu(null); }}
          >
            🗑️ Delete
          </div>
        </div>
      )}

      {/* Project kebab menu: New chat / Rename / Delete project */}
      {projectMenu && (
        <div className="context-menu" style={{ top: projectMenu.y, left: projectMenu.x }}>
          <div
            className="context-menu-item"
            onClick={() => { onNewSessionInProject(projectMenu.project); setProjectMenu(null); }}
          >
            ＋ New chat in project
          </div>
          <div
            className="context-menu-item"
            onClick={() => { setProjectRenamePopup({ project: projectMenu.project }); setProjectMenu(null); }}
          >
            ✏️ Rename project
          </div>
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => { onDeleteProject(projectMenu.project); setProjectMenu(null); }}
          >
            🗑️ Delete project
          </div>
        </div>
      )}

      {/* Two groups, not one flat row: the action buttons must reflow to a second
          line as a UNIT when the sidebar is narrow. Flat children would break at
          an arbitrary button and strand one or two on the next line. */}
      <div className="sidebar-status-bar">
        <div className="sidebar-status-info">
          <span className={`status-dot ${status}`} />
          <span className="sidebar-status-label" title={status}>{status}</span>
          {executorCap ? (
            <span className="sidebar-slot-count" title={`已连接 ${attachedSessionIds.length} / 上限 ${executorCap} 个会话执行器`}>
              {attachedSessionIds.length}/{executorCap}
            </span>
          ) : null}
        </div>
        <div className="sidebar-status-actions">
          <button
            className={`sidebar-settings-btn sidebar-workspace-btn${workspaceOpen ? ' active' : ''}`}
            onClick={onOpenWorkspace}
            title={workspaceOpen ? 'Close workspace files' : 'Open workspace files'}
            aria-label={workspaceOpen ? 'Close workspace files' : 'Open workspace files'}
            aria-pressed={workspaceOpen}
          >
            <IconWorkspaceFolder size={19} className="sidebar-workspace-icon" />
          </button>
          <button
            className="sidebar-settings-btn sidebar-workspace-btn"
            onClick={onOpenAgentConfig}
            title="编辑当前 Agent 配置（全局）"
            aria-label="编辑当前 Agent 配置"
          >
            <IconRobot size={17} />
          </button>
          <button className="sidebar-settings-btn" onClick={onOpenMemory} title="Memory">
            🧠
          </button>
          <button className="sidebar-settings-btn" onClick={onSettings} title="Settings">
            ⚙️
          </button>
          <button
            className="sidebar-settings-btn sidebar-workspace-btn"
            onClick={onOpenLogs}
            title="日志"
            aria-label="日志"
          >
            <IconLogs size={18} />
          </button>
        </div>
      </div>

      {/* Rename popup */}
      {renamePopup && (
        <>
          <div className="overlay" onClick={() => setRenamePopup(null)} />
          <div className="rename-popup">
            <h4>Rename</h4>
            <input
              autoFocus
              className="rename-popup-input"
              defaultValue={renamePopup.value}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) onRenameSession(renamePopup.id, val);
                  setRenamePopup(null);
                } else if (e.key === 'Escape') {
                  setRenamePopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setRenamePopup(null)}>Cancel</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.rename-popup-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) onRenameSession(renamePopup.id, val);
                  setRenamePopup(null);
                }}
              >OK</button>
            </div>
          </div>
        </>
      )}

      {/* Assign-to-new-project popup (write-once) */}
      {assignPopup && (
        <>
          <div className="overlay" onClick={() => setAssignPopup(null)} />
          <div className="rename-popup">
            <h4>Move to new project</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              Creates the project and moves this chat into it (its executor resets to the new memory scope).
            </p>
            <input
              autoFocus
              className="rename-popup-input assign-popup-input"
              placeholder="Project name…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) onMoveSession(assignPopup.sessionId, val);
                  setAssignPopup(null);
                } else if (e.key === 'Escape') {
                  setAssignPopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setAssignPopup(null)}>Cancel</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.assign-popup-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) onMoveSession(assignPopup.sessionId, val);
                  setAssignPopup(null);
                }}
              >Move</button>
            </div>
          </div>
        </>
      )}

      {/* Rename-project popup */}
      {projectRenamePopup && (
        <>
          <div className="overlay" onClick={() => setProjectRenamePopup(null)} />
          <div className="rename-popup">
            <h4>Rename project</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              Renames the project and relabels all its sessions.
            </p>
            <input
              autoFocus
              className="rename-popup-input project-rename-input"
              defaultValue={projectRenamePopup.project}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) onRenameProject(projectRenamePopup.project, val);
                  setProjectRenamePopup(null);
                } else if (e.key === 'Escape') {
                  setProjectRenamePopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setProjectRenamePopup(null)}>Cancel</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.project-rename-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) onRenameProject(projectRenamePopup.project, val);
                  setProjectRenamePopup(null);
                }}
              >Rename</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
