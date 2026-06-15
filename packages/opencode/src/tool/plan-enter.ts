import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID } from "../session/schema"
import ENTER_DESCRIPTION from "./plan-enter.txt"

export const Parameters = Schema.Struct({})

export const PlanEnterTool = Tool.define(
  "plan_enter",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description: ENTER_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const autoRetry = yield* RuntimeFlags.planAutoRetryState.get(flags)

          if (autoRetry) {
            const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
            const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
            const model =
              lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

            const msg: SessionV1.User = {
              id: MessageID.ascending(),
              sessionID: ctx.sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: "plan",
              model,
            }
            yield* session.updateMessage(msg)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: ctx.sessionID,
              type: "text",
              text: `The plan at ${plan} needs revision. Review the failures and update the plan.`,
              synthetic: true,
            } satisfies SessionV1.TextPart)

            return {
              title: "Returning to plan agent",
              output: "Auto-returning to plan agent.",
              metadata: {},
            }
          }

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: "Return to plan mode to revise the plan?",
                header: "Plan Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Return to plan agent to revise the plan" },
                  { label: "No", description: "Stay in build mode and continue" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "plan",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} needs revision. Review the failures and update the plan.`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Returning to plan agent",
            output: "Returning to plan agent to revise the plan.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
