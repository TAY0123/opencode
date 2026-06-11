import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import VERIFY_MODE from "./prompt/verify-mode.txt"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  const prevAgent = assistantMessage?.info.agent
  const current = input.agent.name

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)

  if (current === "verify" && prevAgent === "plan") {
    const planDir = path.dirname(plan)
    const planExists = yield* fsys.existsSafe(plan)
    if (!planExists) yield* fsys.ensureDir(planDir).pipe(Effect.catch(Effect.die))
    const planJson = plan.replace(/\.md$/, ".plan.json")
    const planJsonExists = yield* fsys.existsSafe(planJson)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: VERIFY_MODE.replace("${planInfo}", () =>
        planJsonExists
          ? `A plan.json file exists at ${planJson}. Read it and validate it.`
          : `No plan.json file exists. Validate the markdown plan at ${plan} against policy rules.`,
      ),
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (current !== "plan" && current !== "verify" && (prevAgent === "plan" || prevAgent === "verify")) {
    const planJson = plan.replace(/\.md$/, ".plan.json")
    const planJsonExists = yield* fsys.existsSafe(planJson)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: planJsonExists
        ? `${BUILD_SWITCH}\n\nA plan.json file exists at ${planJson}. Read it for phase scopes and execute phase by phase.`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (current !== "plan" || prevAgent === "plan") return input.messages

  const planDir = path.dirname(plan)
  const planExists = yield* fsys.existsSafe(plan)
  if (!planExists) yield* fsys.ensureDir(planDir).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      planExists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
