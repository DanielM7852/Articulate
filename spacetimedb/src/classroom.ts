import { table, t } from "spacetimedb/server";
import {
  canonical,
  defaultSettings,
  describeChange,
  findingKind,
  MIN_REPEAT,
  parseSettings,
  type LessonSettings,
} from "./lessonRules";

const profileIdRe = /^[A-Za-z0-9_.:@-]{1,64}$/;
const codeRe = /^[a-f0-9]{32,64}$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const classInvite = table(
  { name: "class_invite", public: false },
  {
    code: t.string().primaryKey(),
    role: t.string(),
    profile_id: t.string(),
    classroom_id: t.string(),
    display_name: t.string(),
    consumed: t.bool(),
  },
);

export const classIdentity = table(
  { name: "class_identity", public: false },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    profile_id: t.string().unique(),
    classroom_id: t.string().index(),
    display_name: t.string(),
  },
);

export const classRoom = table(
  { name: "class_room", public: false },
  { id: t.string().primaryKey(), name: t.string(), teacher_profile: t.string() },
);

export const classMember = table(
  { name: "class_member", public: false },
  {
    id: t.string().primaryKey(),
    profile_id: t.string().index(),
    classroom_id: t.string().index(),
    display_name: t.string(),
  },
);

export const lessonOverride = table(
  { name: "lesson_override", public: false },
  {
    profile_id: t.string().primaryKey(),
    revision: t.u32(),
    command_id: t.string(),
    settings_json: t.string(),
    visible: t.string(),
    status: t.string(),
    expires_at: t.u64(),
    saved_at: t.u64(),
    actor_profile: t.string(),
  },
);

export const classAssignment = table(
  { name: "class_assignment", public: false },
  {
    classroom_id: t.string().primaryKey(),
    revision: t.u32(),
    command_id: t.string(),
    settings_json: t.string(),
    visible: t.string(),
    status: t.string(),
    expires_at: t.u64(),
    saved_at: t.u64(),
    actor_profile: t.string(),
  },
);

export const lessonCommand = table(
  { name: "lesson_command", public: false },
  {
    command_id: t.string().primaryKey(),
    profile_id: t.string().index(),
    classroom_id: t.string(),
    scope: t.string(),
    actor_profile: t.string(),
    expected_revision: t.u32(),
    new_revision: t.u32(),
    settings_json: t.string(),
    visible: t.string(),
    outcome: t.string(),
    created_at: t.u64(),
  },
);

export const lessonAck = table(
  { name: "lesson_ack", public: false },
  {
    profile_id: t.string().primaryKey(),
    revision: t.u32(),
    command_id: t.string(),
    phase: t.string(),
    received_at: t.u64(),
    applied_at: t.u64(),
  },
);

export const lessonAckEvent = table(
  { name: "lesson_ack_event", public: false },
  {
    id: t.string().primaryKey(),
    profile_id: t.string().index(),
    revision: t.u32(),
    command_id: t.string(),
    phase: t.string(),
    at: t.u64(),
  },
);

export const attemptSummary = table(
  { name: "attempt_summary", public: false },
  {
    attempt_id: t.string().primaryKey(),
    profile_id: t.string().index(),
    exercise: t.string(),
    usable: t.bool(),
    finding: t.string(),
    kind: t.string(),
    provenance: t.string(),
    reference_version: t.string(),
    analysis_version: t.string(),
    cue_id: t.string(),
    measurements_json: t.string(),
    synthetic: t.bool(),
    created_at: t.u64(),
  },
);

export const learnerRoll = table(
  { name: "learner_roll", public: false },
  {
    profile_id: t.string().primaryKey(),
    display_name: t.string(),
    classroom_id: t.string(),
    presence: t.string(),
    presence_at: t.u64(),
    exercise: t.string(),
    lesson_revision: t.u32(),
    lesson_source: t.string(),
    settings_json: t.string(),
    override_revision: t.u32(),
    classroom_revision: t.u32(),
    visible: t.string(),
    ack_phase: t.string(),
    ack_revision: t.u32(),
    usable: t.u32(),
    unusable: t.u32(),
    last_finding: t.string(),
    last_kind: t.string(),
    last_provenance: t.string(),
    last_at: t.u64(),
    repeat_finding: t.string(),
    repeat_count: t.u32(),
    reference_version: t.string(),
    synthetic_finding: t.string(),
    synthetic_repeat: t.u32(),
    help_requested: t.bool(),
    help_note: t.string(),
  },
);

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

function backendOnly(ctx: any): void {
  const principal = ctx.db.backend.id.find(0);
  if (!principal || !ctx.sender.isEqual(principal.identity)) throw new Error("backend only");
}

function binding(ctx: any): any {
  return ctx.db.classIdentity.identity.find(ctx.sender);
}

function requireTeacher(ctx: any, classroomId: string): any {
  const me = binding(ctx);
  if (!me || me.role !== "teacher" || me.classroom_id !== classroomId) throw new Error("not a teacher");
  return me;
}

function requireLearner(ctx: any): any {
  const me = binding(ctx);
  if (!me || me.role !== "learner") throw new Error("not a learner");
  return me;
}

function memberId(profileId: string, classroomId: string): string {
  return `${profileId}|${classroomId}`;
}

function active(row: { status: string; expires_at: bigint } | null, now: bigint): boolean {
  if (!row || row.status !== "active") return false;
  return row.expires_at === 0n || row.expires_at > now;
}

export type EffectiveLesson = {
  revision: number;
  commandId: string;
  source: "default" | "learner" | "classroom";
  settings: LessonSettings;
  visible: string;
  status: string;
};

export function effectiveLesson(ctx: any, profileId: string, classroomId: string, now: bigint): EffectiveLesson {
  const override = ctx.db.lessonOverride.profile_id.find(profileId);
  if (active(override, now)) {
    return {
      revision: override.revision,
      commandId: override.command_id,
      source: "learner",
      settings: parseSettings(override.settings_json),
      visible: override.visible,
      status: "active",
    };
  }
  const assignment = ctx.db.classAssignment.classroom_id.find(classroomId);
  if (active(assignment, now)) {
    return {
      revision: assignment.revision,
      commandId: assignment.command_id,
      source: "classroom",
      settings: parseSettings(assignment.settings_json),
      visible: assignment.visible,
      status: "active",
    };
  }
  const settings = defaultSettings();
  return {
    revision: 0,
    commandId: "",
    source: "default",
    settings,
    visible: "Default plan. Target i. Context sound. Cue spread-lips. Assistance cue-target. Reference replay off. Repetitions 1.",
    status: "active",
  };
}

function classroomRevision(ctx: any, classroomId: string): number {
  return ctx.db.classAssignment.classroom_id.find(classroomId)?.revision ?? 0;
}

function overrideRevision(ctx: any, profileId: string): number {
  return ctx.db.lessonOverride.profile_id.find(profileId)?.revision ?? 0;
}

function blankRoll(profileId: string, classroomId: string, displayName: string, now: bigint): any {
  return {
    profile_id: profileId,
    display_name: displayName,
    classroom_id: classroomId,
    presence: "unknown",
    presence_at: now,
    exercise: "unknown",
    lesson_revision: 0,
    lesson_source: "default",
    settings_json: canonical(defaultSettings()),
    override_revision: 0,
    classroom_revision: 0,
    visible: "",
    ack_phase: "none",
    ack_revision: 0,
    usable: 0,
    unusable: 0,
    last_finding: "unknown",
    last_kind: "unknown",
    last_provenance: "unknown",
    last_at: 0n,
    repeat_finding: "",
    repeat_count: 0,
    reference_version: "unknown",
    synthetic_finding: "",
    synthetic_repeat: 0,
    help_requested: false,
    help_note: "",
  };
}

function refreshRollLesson(ctx: any, profileId: string, classroomId: string, now: bigint): void {
  const roll = ctx.db.learnerRoll.profile_id.find(profileId) ?? blankRoll(profileId, classroomId, "unknown", now);
  const lesson = effectiveLesson(ctx, profileId, classroomId, now);
  const ack = ctx.db.lessonAck.profile_id.find(profileId);
  const ackPhase = ack && ack.revision === lesson.revision && lesson.revision > 0 ? ack.phase : lesson.revision > 0 ? "pending" : "none";
  const next = {
    ...roll,
    classroom_id: classroomId,
    lesson_revision: lesson.revision,
    lesson_source: lesson.source,
    settings_json: canonical(lesson.settings),
    override_revision: overrideRevision(ctx, profileId),
    classroom_revision: classroomRevision(ctx, classroomId),
    visible: lesson.visible,
    ack_phase: ackPhase,
    ack_revision: lesson.revision,
    exercise: lesson.settings.target,
  };
  if (ctx.db.learnerRoll.profile_id.find(profileId)) ctx.db.learnerRoll.profile_id.update(next);
  else ctx.db.learnerRoll.insert(next);
}

function refreshClassroom(ctx: any, classroomId: string, now: bigint): void {
  for (const member of ctx.db.classMember.classroom_id.filter(classroomId)) {
    refreshRollLesson(ctx, member.profile_id, classroomId, now);
  }
}

function recordEvent(ctx: any, profileId: string, revision: number, commandId: string, phase: string, at: bigint): void {
  const id = `${profileId}:${revision}:${phase}:${commandId}`;
  if (ctx.db.lessonAckEvent.id.find(id)) return;
  ctx.db.lessonAckEvent.insert({ id, profile_id: profileId, revision, command_id: commandId, phase, at });
}

export function mintInvite(ctx: any, args: {
  code: string;
  role: string;
  profile_id: string;
  classroom_id: string;
  display_name: string;
}): void {
  backendOnly(ctx);
  if (!codeRe.test(args.code) || !profileIdRe.test(args.profile_id) || !profileIdRe.test(args.classroom_id)) {
    throw new Error("invalid settings");
  }
  if (args.role !== "teacher" && args.role !== "learner") throw new Error("invalid settings");
  if (args.display_name.length < 1 || args.display_name.length > 80) throw new Error("invalid settings");
  if (ctx.db.classInvite.code.find(args.code)) throw new Error("invite already used");
  if (args.role === "teacher") {
    const room = ctx.db.classRoom.id.find(args.classroom_id);
    if (room && room.teacher_profile !== args.profile_id) throw new Error("not in classroom");
    if (!room) ctx.db.classRoom.insert({ id: args.classroom_id, name: args.classroom_id, teacher_profile: args.profile_id });
  } else if (!ctx.db.classRoom.id.find(args.classroom_id)) {
    throw new Error("not in classroom");
  }
  ctx.db.classInvite.insert({ ...args, consumed: false });
}

export function acceptInvite(ctx: any, code: string): void {
  if (!codeRe.test(code)) throw new Error("unknown invite");
  const invite = ctx.db.classInvite.code.find(code);
  const me = binding(ctx);
  if (!invite) {
    if (me) return;
    throw new Error("unknown invite");
  }
  if (me) {
    if (me.profile_id !== invite.profile_id) throw new Error("identity already bound");
    return;
  }
  if (invite.consumed) throw new Error("invite already used");
  ctx.db.classIdentity.insert({
    identity: ctx.sender,
    role: invite.role,
    profile_id: invite.profile_id,
    classroom_id: invite.classroom_id,
    display_name: invite.display_name,
  });
  ctx.db.classInvite.code.update({ ...invite, consumed: true });
  if (invite.role === "learner") {
    const id = memberId(invite.profile_id, invite.classroom_id);
    if (!ctx.db.classMember.id.find(id)) {
      ctx.db.classMember.insert({
        id,
        profile_id: invite.profile_id,
        classroom_id: invite.classroom_id,
        display_name: invite.display_name,
      });
    }
    refreshRollLesson(ctx, invite.profile_id, invite.classroom_id, nowMicros(ctx));
    const roll = ctx.db.learnerRoll.profile_id.find(invite.profile_id);
    if (roll) ctx.db.learnerRoll.profile_id.update({ ...roll, display_name: invite.display_name, presence: "idle" });
  }
}

function previousSettings(ctx: any, scope: string, profileId: string, classroomId: string): LessonSettings | null {
  if (scope === "learner") {
    const row = ctx.db.lessonOverride.profile_id.find(profileId);
    return row ? parseSettings(row.settings_json) : null;
  }
  const row = ctx.db.classAssignment.classroom_id.find(classroomId);
  return row ? parseSettings(row.settings_json) : null;
}

export function saveLesson(ctx: any, args: {
  command_id: string;
  scope: string;
  target_profile: string;
  classroom_id: string;
  expected_revision: number;
  settings_json: string;
  expires_in_minutes: number;
}): void {
  if (!uuidRe.test(args.command_id)) throw new Error("invalid settings");
  if (args.scope !== "learner" && args.scope !== "classroom") throw new Error("invalid settings");
  if (!profileIdRe.test(args.classroom_id)) throw new Error("invalid settings");
  if (args.expires_in_minutes < 0 || args.expires_in_minutes > 1440) throw new Error("invalid settings");
  const teacher = requireTeacher(ctx, args.classroom_id);
  const settings = parseSettings(args.settings_json);
  const stored = canonical(settings);
  const existing = ctx.db.lessonCommand.command_id.find(args.command_id);
  if (existing) {
    if (existing.settings_json === stored && existing.actor_profile === teacher.profile_id && existing.scope === args.scope) return;
    throw new Error("idempotency conflict");
  }
  const now = nowMicros(ctx);
  const expires = args.expires_in_minutes === 0 ? 0n : now + BigInt(args.expires_in_minutes) * 60n * 1000000n;
  if (args.scope === "learner") {
    if (!profileIdRe.test(args.target_profile)) throw new Error("invalid settings");
    const member = ctx.db.classMember.id.find(memberId(args.target_profile, args.classroom_id));
    if (!member) throw new Error("not in classroom");
    const current = overrideRevision(ctx, args.target_profile);
    if (args.expected_revision !== current) throw new Error("revision conflict");
    const visible = describeChange(previousSettings(ctx, "learner", args.target_profile, args.classroom_id), settings);
    const revision = current + 1;
    const row = {
      profile_id: args.target_profile,
      revision,
      command_id: args.command_id,
      settings_json: stored,
      visible,
      status: "active",
      expires_at: expires,
      saved_at: now,
      actor_profile: teacher.profile_id,
    };
    if (current === 0) ctx.db.lessonOverride.insert(row);
    else ctx.db.lessonOverride.profile_id.update(row);
    ctx.db.lessonCommand.insert({
      command_id: args.command_id,
      profile_id: args.target_profile,
      classroom_id: args.classroom_id,
      scope: "learner",
      actor_profile: teacher.profile_id,
      expected_revision: args.expected_revision,
      new_revision: revision,
      settings_json: stored,
      visible,
      outcome: "saved",
      created_at: now,
    });
    const previousAck = ctx.db.lessonAck.profile_id.find(args.target_profile);
    if (previousAck && previousAck.revision !== revision) {
      recordEvent(ctx, args.target_profile, previousAck.revision, previousAck.command_id, "superseded", now);
    }
    refreshRollLesson(ctx, args.target_profile, args.classroom_id, now);
    return;
  }
  const current = classroomRevision(ctx, args.classroom_id);
  if (args.expected_revision !== current) throw new Error("revision conflict");
  const visible = describeChange(previousSettings(ctx, "classroom", "", args.classroom_id), settings);
  const revision = current + 1;
  const row = {
    classroom_id: args.classroom_id,
    revision,
    command_id: args.command_id,
    settings_json: stored,
    visible,
    status: "active",
    expires_at: expires,
    saved_at: now,
    actor_profile: teacher.profile_id,
  };
  if (current === 0) ctx.db.classAssignment.insert(row);
  else ctx.db.classAssignment.classroom_id.update(row);
  ctx.db.lessonCommand.insert({
    command_id: args.command_id,
    profile_id: "",
    classroom_id: args.classroom_id,
    scope: "classroom",
    actor_profile: teacher.profile_id,
    expected_revision: args.expected_revision,
    new_revision: revision,
    settings_json: stored,
    visible,
    outcome: "saved",
    created_at: now,
  });
  refreshClassroom(ctx, args.classroom_id, now);
}

export function revokeLesson(ctx: any, args: {
  command_id: string;
  scope: string;
  target_profile: string;
  classroom_id: string;
  expected_revision: number;
}): void {
  if (!uuidRe.test(args.command_id)) throw new Error("invalid settings");
  const teacher = requireTeacher(ctx, args.classroom_id);
  const now = nowMicros(ctx);
  const existing = ctx.db.lessonCommand.command_id.find(args.command_id);
  if (existing) {
    if (existing.outcome === "revoked" && existing.actor_profile === teacher.profile_id) return;
    throw new Error("idempotency conflict");
  }
  if (args.scope === "learner") {
    const row = ctx.db.lessonOverride.profile_id.find(args.target_profile);
    if (!row || row.revision !== args.expected_revision) throw new Error("revision conflict");
    const revision = row.revision + 1;
    ctx.db.lessonOverride.profile_id.update({
      ...row,
      revision,
      command_id: args.command_id,
      status: "revoked",
      visible: "Lesson override revoked. The classroom or default plan applies.",
      saved_at: now,
      actor_profile: teacher.profile_id,
      expires_at: 0n,
    });
    ctx.db.lessonCommand.insert({
      command_id: args.command_id,
      profile_id: args.target_profile,
      classroom_id: args.classroom_id,
      scope: "learner",
      actor_profile: teacher.profile_id,
      expected_revision: args.expected_revision,
      new_revision: revision,
      settings_json: row.settings_json,
      visible: "Lesson override revoked. The classroom or default plan applies.",
      outcome: "revoked",
      created_at: now,
    });
    refreshRollLesson(ctx, args.target_profile, args.classroom_id, now);
    return;
  }
  const row = ctx.db.classAssignment.classroom_id.find(args.classroom_id);
  if (!row || row.revision !== args.expected_revision) throw new Error("revision conflict");
  const revision = row.revision + 1;
  ctx.db.classAssignment.classroom_id.update({
    ...row,
    revision,
    command_id: args.command_id,
    status: "revoked",
    visible: "Classroom assignment revoked. The default plan applies unless a learner override is active.",
    saved_at: now,
    actor_profile: teacher.profile_id,
    expires_at: 0n,
  });
  ctx.db.lessonCommand.insert({
    command_id: args.command_id,
    profile_id: "",
    classroom_id: args.classroom_id,
    scope: "classroom",
    actor_profile: teacher.profile_id,
    expected_revision: args.expected_revision,
    new_revision: revision,
    settings_json: row.settings_json,
    visible: "Classroom assignment revoked. The default plan applies unless a learner override is active.",
    outcome: "revoked",
    created_at: now,
  });
  refreshClassroom(ctx, args.classroom_id, now);
}

export function ackLesson(ctx: any, args: { revision: number; phase: string; command_id: string }): void {
  const me = requireLearner(ctx);
  if (args.phase !== "received" && args.phase !== "applied" && args.phase !== "failed") throw new Error("invalid settings");
  const now = nowMicros(ctx);
  const lesson = effectiveLesson(ctx, me.profile_id, me.classroom_id, now);
  if (lesson.revision === 0) throw new Error("superseded");
  if (args.revision !== lesson.revision || args.command_id !== lesson.commandId) throw new Error("superseded");
  const override = ctx.db.lessonOverride.profile_id.find(me.profile_id);
  const assignment = ctx.db.classAssignment.classroom_id.find(me.classroom_id);
  const sourceRow = lesson.source === "learner" ? override : assignment;
  if (sourceRow && sourceRow.expires_at !== 0n && sourceRow.expires_at <= now) throw new Error("expired");
  const current = ctx.db.lessonAck.profile_id.find(me.profile_id);
  if (current && current.revision === args.revision && current.command_id === args.command_id) {
    if (current.phase === "applied" || current.phase === args.phase) return;
  }
  const row = {
    profile_id: me.profile_id,
    revision: args.revision,
    command_id: args.command_id,
    phase: args.phase,
    received_at: current?.revision === args.revision ? current.received_at : now,
    applied_at: args.phase === "applied" ? now : current?.revision === args.revision ? current.applied_at : 0n,
  };
  if (current) ctx.db.lessonAck.profile_id.update(row);
  else ctx.db.lessonAck.insert(row);
  recordEvent(ctx, me.profile_id, args.revision, args.command_id, args.phase, now);
  refreshRollLesson(ctx, me.profile_id, me.classroom_id, now);
}

export function setPresence(ctx: any, presence: string, exercise: string): void {
  const me = requireLearner(ctx);
  if (!["idle", "recording", "analyzing"].includes(presence)) throw new Error("invalid settings");
  if (exercise.length > 32) throw new Error("invalid settings");
  const now = nowMicros(ctx);
  refreshRollLesson(ctx, me.profile_id, me.classroom_id, now);
  const roll = ctx.db.learnerRoll.profile_id.find(me.profile_id);
  const nextExercise = exercise && exercise !== "unknown" ? exercise : roll.exercise;
  ctx.db.learnerRoll.profile_id.update({ ...roll, presence, presence_at: now, exercise: nextExercise });
}

export function requestHelp(ctx: any, message: string): void {
  const me = requireLearner(ctx);
  if (message.length > MAX_NOTE()) throw new Error("invalid settings");
  const now = nowMicros(ctx);
  refreshRollLesson(ctx, me.profile_id, me.classroom_id, now);
  const roll = ctx.db.learnerRoll.profile_id.find(me.profile_id);
  ctx.db.learnerRoll.profile_id.update({ ...roll, help_requested: true, help_note: message });
}

function MAX_NOTE(): number {
  return 160;
}

export function clearHelp(ctx: any, profileId: string): void {
  const me = binding(ctx);
  if (!me || me.role !== "teacher") throw new Error("not a teacher");
  const member = ctx.db.classMember.id.find(memberId(profileId, me.classroom_id));
  if (!member) throw new Error("not in classroom");
  const roll = ctx.db.learnerRoll.profile_id.find(profileId);
  if (!roll) return;
  ctx.db.learnerRoll.profile_id.update({ ...roll, help_requested: false, help_note: "" });
}

function checkMeasurements(text: string): string {
  if (text.length > 1500) throw new Error("invalid settings");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("invalid settings");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid settings");
  return text;
}

function applyFinding(roll: any, args: {
  exercise: string;
  usable: boolean;
  finding: string;
  kind: string;
  provenance: string;
  reference_version: string;
  synthetic: boolean;
  created_at: bigint;
}): any {
  const next = {
    ...roll,
    exercise: args.exercise,
    last_finding: args.finding || "none",
    last_kind: args.kind,
    last_provenance: args.provenance,
    last_at: args.created_at,
  };
  if (args.synthetic) {
    const same = args.finding !== "" && args.finding === roll.synthetic_finding && args.reference_version === roll.reference_version;
    next.synthetic_finding = args.finding;
    next.synthetic_repeat = same ? roll.synthetic_repeat + 1 : args.finding ? 1 : 0;
    next.reference_version = args.reference_version || roll.reference_version;
    return next;
  }
  if (!args.usable || args.kind === "capture") {
    next.unusable = roll.unusable + 1;
    return next;
  }
  next.usable = roll.usable + 1;
  if (args.provenance === "verified" && args.kind === "performance" && args.finding) {
    const same = args.finding === roll.repeat_finding && args.reference_version === roll.reference_version;
    next.repeat_finding = args.finding;
    next.repeat_count = same ? roll.repeat_count + 1 : 1;
    next.reference_version = args.reference_version;
  }
  return next;
}

export function reportProvisional(ctx: any, args: {
  attempt_id: string;
  exercise: string;
  usable: boolean;
  finding: string;
  reference_version: string;
  measurements_json: string;
}): void {
  const me = requireLearner(ctx);
  if (!uuidRe.test(args.attempt_id)) throw new Error("invalid settings");
  if (ctx.db.attemptSummary.attempt_id.find(args.attempt_id)) return;
  const kind = findingKind(args.finding === "none" ? "" : args.finding);
  const now = nowMicros(ctx);
  ctx.db.attemptSummary.insert({
    attempt_id: args.attempt_id,
    profile_id: me.profile_id,
    exercise: args.exercise.slice(0, 32),
    usable: args.usable,
    finding: args.finding === "none" ? "" : args.finding,
    kind,
    provenance: "provisional",
    reference_version: args.reference_version.slice(0, 64) || "unknown",
    analysis_version: "client",
    cue_id: "",
    measurements_json: checkMeasurements(args.measurements_json),
    synthetic: false,
    created_at: now,
  });
  refreshRollLesson(ctx, me.profile_id, me.classroom_id, now);
  const roll = ctx.db.learnerRoll.profile_id.find(me.profile_id);
  ctx.db.learnerRoll.profile_id.update(applyFinding(roll, {
    exercise: args.exercise.slice(0, 32),
    usable: args.usable,
    finding: args.finding === "none" ? "" : args.finding,
    kind,
    provenance: "provisional",
    reference_version: args.reference_version || "unknown",
    synthetic: false,
    created_at: now,
  }));
}

export function commitVerified(ctx: any, args: {
  profile_id: string;
  attempt_id: string;
  exercise: string;
  usable: boolean;
  finding: string;
  provenance: string;
  reference_version: string;
  analysis_version: string;
  cue_id: string;
  measurements_json: string;
  synthetic: boolean;
}): void {
  backendOnly(ctx);
  if (!profileIdRe.test(args.profile_id) || !uuidRe.test(args.attempt_id)) throw new Error("invalid settings");
  if (args.provenance !== "verified" && args.provenance !== "synthetic") throw new Error("invalid settings");
  if (args.synthetic !== (args.provenance === "synthetic")) throw new Error("invalid settings");
  if (ctx.db.attemptSummary.attempt_id.find(args.attempt_id)) return;
  const memberRows = [...ctx.db.classMember.profile_id.filter(args.profile_id)];
  if (memberRows.length !== 1) throw new Error("not in classroom");
  const kind = findingKind(args.finding === "none" ? "" : args.finding);
  const now = nowMicros(ctx);
  ctx.db.attemptSummary.insert({
    attempt_id: args.attempt_id,
    profile_id: args.profile_id,
    exercise: args.exercise.slice(0, 32),
    usable: args.usable,
    finding: args.finding === "none" ? "" : args.finding,
    kind,
    provenance: args.provenance,
    reference_version: args.reference_version.slice(0, 64) || "unknown",
    analysis_version: args.analysis_version.slice(0, 64) || "unknown",
    cue_id: args.cue_id.slice(0, 64),
    measurements_json: checkMeasurements(args.measurements_json),
    synthetic: args.synthetic,
    created_at: now,
  });
  refreshRollLesson(ctx, args.profile_id, memberRows[0].classroom_id, now);
  const roll = ctx.db.learnerRoll.profile_id.find(args.profile_id);
  ctx.db.learnerRoll.profile_id.update(applyFinding(roll, {
    exercise: args.exercise.slice(0, 32),
    usable: args.usable,
    finding: args.finding === "none" ? "" : args.finding,
    kind,
    provenance: args.provenance,
    reference_version: args.reference_version || "unknown",
    synthetic: args.synthetic,
    created_at: now,
  }));
}

export function markDisconnected(ctx: any): void {
  const me = binding(ctx);
  if (!me || me.role !== "learner") return;
  const roll = ctx.db.learnerRoll.profile_id.find(me.profile_id);
  if (!roll) return;
  ctx.db.learnerRoll.profile_id.update({ ...roll, presence: "disconnected", presence_at: nowMicros(ctx) });
}

function lessonFacts(ctx: any, profileId: string, classroomId: string, source: string, revision: number) {
  const room = ctx.db.classRoom.id.find(classroomId);
  let actor = "";
  let savedAt = 0n;
  if (source === "learner") {
    const row = ctx.db.lessonOverride.profile_id.find(profileId);
    if (row && row.revision === revision) {
      actor = row.actor_profile || "";
      savedAt = row.saved_at || 0n;
    }
  } else if (source === "classroom") {
    const row = ctx.db.classAssignment.classroom_id.find(classroomId);
    if (row && row.revision === revision) {
      actor = row.actor_profile || "";
      savedAt = row.saved_at || 0n;
    }
  }
  const teacher = actor ? ctx.db.classIdentity.profile_id.find(actor) : null;
  const ack = ctx.db.lessonAck.profile_id.find(profileId);
  const matching = Boolean(ack && ack.revision === revision);
  return {
    teacher_name: teacher?.display_name || "",
    classroom_name: room?.name || "",
    saved_at: savedAt,
    received_at: matching ? ack.received_at : 0n,
    applied_at: matching ? ack.applied_at : 0n,
  };
}

function lessonRow(ctx: any, profileId: string, classroomId: string, lesson: EffectiveLesson, ackPhase: string) {
  return {
    profile_id: profileId,
    revision: lesson.revision,
    command_id: lesson.commandId,
    source: lesson.source,
    settings_json: canonical(lesson.settings),
    visible: lesson.visible,
    status: lesson.status,
    ack_phase: ackPhase,
    ...lessonFacts(ctx, profileId, classroomId, lesson.source, lesson.revision),
  };
}

export function myLessonRows(ctx: any): any[] {
  const me = binding(ctx);
  if (!me || me.role !== "learner") return [];
  const roll = ctx.db.learnerRoll.profile_id.find(me.profile_id);
  if (!roll) {
    const lesson = effectiveLesson(ctx, me.profile_id, me.classroom_id, 0n);
    return [lessonRow(ctx, me.profile_id, me.classroom_id, lesson, "none")];
  }
  return [{
    profile_id: me.profile_id,
    revision: roll.lesson_revision,
    command_id: effectiveCommand(ctx, me.profile_id, me.classroom_id, roll),
    source: roll.lesson_source,
    settings_json: roll.settings_json,
    visible: roll.visible,
    status: roll.lesson_source === "default" ? "active" : "active",
    ack_phase: roll.ack_phase,
    ...lessonFacts(ctx, me.profile_id, me.classroom_id, roll.lesson_source, roll.lesson_revision),
  }];
}

function effectiveCommand(ctx: any, profileId: string, classroomId: string, roll: any): string {
  if (roll.lesson_source === "learner") return ctx.db.lessonOverride.profile_id.find(profileId)?.command_id ?? "";
  if (roll.lesson_source === "classroom") return ctx.db.classAssignment.classroom_id.find(classroomId)?.command_id ?? "";
  return "";
}

function boardRow(roll: any): any {
  const needs = roll.last_provenance === "verified" && roll.repeat_count >= MIN_REPEAT;
  return {
    profile_id: roll.profile_id,
    display_name: roll.display_name || "unknown",
    classroom_id: roll.classroom_id,
    presence: roll.presence || "unknown",
    presence_at: roll.presence_at,
    exercise: roll.exercise || "unknown",
    lesson_revision: roll.lesson_revision,
    lesson_source: roll.lesson_source || "unknown",
    override_revision: roll.override_revision,
    classroom_revision: roll.classroom_revision,
    visible: roll.visible || "",
    settings_json: roll.settings_json || "",
    ack_phase: roll.ack_phase || "unknown",
    usable: roll.usable,
    unusable: roll.unusable,
    last_finding: roll.last_finding || "unknown",
    last_kind: roll.last_kind || "unknown",
    last_provenance: roll.last_provenance || "unknown",
    last_at: roll.last_at,
    repeat_count: roll.repeat_count,
    needs_attention: needs,
    synthetic_repeat: roll.synthetic_repeat,
    help_requested: roll.help_requested,
    help_note: roll.help_note || "",
  };
}

export function classroomBoardRows(ctx: any): any[] {
  const me = binding(ctx);
  if (!me || me.role !== "teacher") return [];
  const out = [];
  for (const member of ctx.db.classMember.classroom_id.filter(me.classroom_id)) {
    const roll = ctx.db.learnerRoll.profile_id.find(member.profile_id);
    if (roll) out.push(boardRow(roll));
  }
  return out;
}

function summaryRow(row: any): any {
  return {
    attempt_id: row.attempt_id,
    profile_id: row.profile_id,
    exercise: row.exercise,
    usable: row.usable,
    finding: row.finding || "none",
    kind: row.kind,
    provenance: row.provenance,
    reference_version: row.reference_version || "unknown",
    analysis_version: row.analysis_version || "unknown",
    cue_id: row.cue_id || "",
    measurements_json: row.measurements_json,
    synthetic: row.synthetic,
    created_at: row.created_at,
  };
}

function recent(ctx: any, profileId: string): any[] {
  const rows = [...ctx.db.attemptSummary.profile_id.filter(profileId)];
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return rows.slice(0, 12).map(summaryRow);
}

export function myAttemptRows(ctx: any): any[] {
  const me = binding(ctx);
  if (!me || me.role !== "learner") return [];
  return recent(ctx, me.profile_id);
}

export function learnerAttemptRows(ctx: any, profileId: string): any[] {
  const me = binding(ctx);
  if (!me || me.role !== "teacher") return [];
  if (!ctx.db.classMember.id.find(memberId(profileId, me.classroom_id))) return [];
  return recent(ctx, profileId);
}
