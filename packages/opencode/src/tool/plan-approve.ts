import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, PartID } from "../session/schema"
import APPROVE_DESCRIPTION from "./plan-approve.txt"

export const Parameters = Schema.Struct({
  passed: Schema.optional(Schema.Boolean),
})

export const PlanApproveTool = Tool.define(
  "plan_approve",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description: APPROVE_DESCRIPTION,
      parameters: Parameters,
      execute: (params: { passed?: boolean }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const autoRetry = yield* RuntimeFlags.planAutoRetryState.get(flags)

          const autoDecision =
            params.passed === true ? "build" :
            params.passed === false && autoRetry ? "plan" :
            undefined

          if (autoDecision !== undefined) {
            const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
            const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
            const model =
              lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

            if (autoDecision === "build") {
              const msg: SessionV1.User = {
                id: MessageID.ascending(),
                sessionID: ctx.sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: "build",
                model,
              }
              yield* session.updateMessage(msg)
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: ctx.sessionID,
                type: "text",
                text: `The plan at ${plan} has been verified and approved. Execute the plan phase by phase, respecting each phase's scope.`,
                synthetic: true,
              } satisfies SessionV1.TextPart)

              return {
                title: "Switching to build agent",
                output: "Auto-transitioning to build agent.",
                metadata: {},
              }
            }

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
              text: "Auto-returning to plan agent. Review the verification failures and update the plan accordingly.",
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
                question: `Plan at ${plan} has been verified and contracts generated. Would you like to proceed to build and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Return to plan agent to revise the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const messages = yield* session.messages({ sessionID: ctx.sessionID }).pipe(Effect.orDie)
          const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
          const model =
            lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()

          if (answers[0]?.[0] === "Yes") {
            const msg: SessionV1.User = {
              id: MessageID.ascending(),
              sessionID: ctx.sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model,
            }
            yield* session.updateMessage(msg)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: ctx.sessionID,
              type: "text",
              text: `The plan at ${plan} has been verified and approved. Execute the plan phase by phase, respecting each phase's scope.`,
              synthetic: true,
            } satisfies SessionV1.TextPart)

            return {
              title: "Switching to build agent",
              output: "User approved switching to build agent. Wait for further instructions.",
              metadata: {},
            }
          }

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
            text: "User chose to revise the plan. Review the verification failures and update the plan accordingly.",
            synthetic: true,
          } satisfies SessionV1.TextPart)

          return {
            title: "Returning to plan agent",
            output: "User chose to return to plan agent.",
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
