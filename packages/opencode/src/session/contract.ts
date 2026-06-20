import { Schema, Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "./session"
import { SessionID } from "./schema"

const BLOCKED_PATHS = [
  ".env",
  ".ssh",
  "id_rsa",
  "credentials",
  "secret",
  "secrets",
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
]

const DANGEROUS_COMMANDS = [
  "rm -rf",
  "sudo ",
  "chmod 777",
  "chown ",
  "curl ",
  "wget ",
  "scp ",
  "ssh ",
  "dd ",
  "mkfs",
]

export const PlanStep = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  target: Schema.String,
  reason: Schema.String,
  risk: Schema.optional(Schema.Literals(["low", "medium", "high"])),
})

export const PlanPhase = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scope: Schema.Array(Schema.String),
  steps: Schema.Array(PlanStep),
  verification_commands: Schema.Array(Schema.String),
  contract_file: Schema.String,
})

export const PlanJson = Schema.Struct({
  goal: Schema.String,
  summary: Schema.String,
  contract_model: Schema.optional(Schema.String).pipe(Schema.NullOr),
  contract_model_variant: Schema.optional(Schema.String).pipe(Schema.NullOr),
  phases: Schema.Array(PlanPhase),
  commands_to_run: Schema.optional(Schema.Array(Schema.String)),
  command_workdirs: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  requires_human_approval: Schema.Boolean,
})

export interface PlanPhase extends Schema.Schema.Type<typeof PlanPhase> {}
export interface PlanJson extends Schema.Schema.Type<typeof PlanJson> {}

export const ContractViolation = Schema.Struct({
  phase: Schema.String,
  rule: Schema.String,
  detail: Schema.String,
})

export const ContractResult = Schema.Struct({
  passed: Schema.Boolean,
  violations: Schema.Array(ContractViolation),
})

export interface ContractResult extends Schema.Schema.Type<typeof ContractResult> {}
export interface ContractViolation extends Schema.Schema.Type<typeof ContractViolation> {}

export const validatePolicy = Effect.fn("Contract.validatePolicy")(function* (plan: PlanJson) {
  const violations: ContractViolation[] = []

  for (const phase of plan.phases) {
    const hasEdit = phase.steps.some((s) => s.action === "edit_file")
    if (hasEdit && phase.scope.length === 0) {
      violations.push({ phase: phase.id, rule: "MISSING_SCOPE", detail: "Phase has edit_file steps but scope is empty" })
    }

    if (hasEdit && phase.verification_commands.length === 0 && !phase.steps.some((s) => s.action === "run_test" || s.action === "run_lint")) {
      violations.push({ phase: phase.id, rule: "EDIT_WITHOUT_VERIFICATION", detail: "Phase edits files but has no verification commands or test/lint steps" })
    }

    for (const step of phase.steps) {
      if (step.action === "edit_file" && step.target) {
        if (!isInScope(step.target, phase.scope)) {
          violations.push({
            phase: phase.id,
            rule: "SCOPE_OUTSIDE_PHASE",
            detail: `Step target "${step.target}" is outside phase scope [${phase.scope.join(", ")}]`,
          })
        }
      }

      if (step.risk === "high" && !plan.requires_human_approval) {
        violations.push({ phase: phase.id, rule: "HIGH_RISK_WITHOUT_HUMAN_APPROVAL", detail: `Step ${step.id} is high risk but requires_human_approval is false` })
      }
    }

    for (const file of phase.scope) {
      if (isBlockedPath(file)) {
        violations.push({ phase: phase.id, rule: "BLOCKED_FILE_PATH", detail: `Scope includes blocked path: ${file}` })
      }
    }

    for (const cmd of phase.verification_commands) {
      if (isDangerousCommand(cmd)) {
        violations.push({ phase: phase.id, rule: "DANGEROUS_COMMAND", detail: `Verification command is dangerous: ${cmd}` })
      }
    }
  }

  return { passed: violations.length === 0, violations } satisfies ContractResult
})

export const checkScope = (allowed: string[], target: string): string[] => {
  return isInScope(target, allowed) ? [] : [target]
}

function isInScope(target: string, scope: readonly string[]): boolean {
  const normalized = target.replace(/\\/g, "/")
  return scope.some((s) => {
    const sn = s.replace(/\\/g, "/")
    return normalized === sn || normalized.startsWith(sn.endsWith("/") ? sn : sn + "/") || sn.startsWith(normalized)
  })
}

function isBlockedPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return BLOCKED_PATHS.some((blocked) => lower.includes(blocked))
}

function isDangerousCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase()
  return DANGEROUS_COMMANDS.some((danger) => lower.includes(danger))
}

export const validatePhase = Effect.fn("Contract.validatePhase")(function* (phase: PlanPhase) {
  const result: ContractResult = { passed: true, violations: [] }
  const fsys = yield* FSUtil.Service

  for (const file of phase.scope) {
    const exists = yield* fsys.existsSafe(file).pipe(Effect.catch(() => Effect.succeed(false)))
    void exists
  }

  return result
})

export class ScopeViolationError extends Schema.TaggedErrorClass<ScopeViolationError>()("ScopeViolationError", {
  file: Schema.String,
  allowedPaths: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Write rejected: "${this.file}" is outside the planned scope. Allowed paths: [${this.allowedPaths.join(", ")}]. To write to this file, update the plan.json to include it in the relevant phase scope.`
  }
}

export class NoPlanError extends Schema.TaggedErrorClass<NoPlanError>()("NoPlanError", {
  planPath: Schema.String,
}) {
  override get message() {
    return `No plan.json found. Use the plan agent to create a plan before writing files.`
  }
}

export const enforceScope = Effect.fn("Contract.enforceScope")(function* (
  sessionID: SessionID,
  target: string,
  agent: string,
  options?: { experimentalPlanMode?: boolean },
) {
  if (agent === "plan" || agent === "verify") return
  const ctx = yield* InstanceState.context
  const sessions = yield* Session.Service
  const fsys = yield* FSUtil.Service

  const info = yield* sessions.get(sessionID)
  const planPath = Session.planJson(info, ctx)
  const raw = yield* fsys.readFileStringSafe(planPath)
  if (!raw) {
    if (options?.experimentalPlanMode && agent === "build") {
      yield* new NoPlanError({ planPath })
    }
    return
  }

  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as PlanJson,
    catch: () => undefined,
  })
  if (!parsed) return

  const absolute = path.isAbsolute(target) ? target : path.resolve(ctx.worktree, target)
  const relative = path.relative(ctx.worktree, absolute)
  if (relative === ".opencode" || relative.startsWith(".opencode/")) {
    if (
      agent === "build" &&
      (relative.startsWith(".opencode/plans/") || relative.startsWith(".opencode/contracts/"))
    ) {
      yield* new ScopeViolationError({
        file: relative,
        allowedPaths: ["(all except .opencode/plans/ and .opencode/contracts/ — build agent cannot modify plan or contract files)"],
      })
    }
    return
  }

  const allScopesRaw = parsed.phases.flatMap((phase) => phase.scope)
  if (allScopesRaw.length === 0) return
  const allScopes = allScopesRaw.map((s) =>
    path.isAbsolute(s) ? s : path.resolve(ctx.worktree, s),
  )
  if (isInScope(absolute, allScopes)) return

  yield* new ScopeViolationError({ file: relative, allowedPaths: allScopesRaw })
})

export * as Contract from "./contract"
