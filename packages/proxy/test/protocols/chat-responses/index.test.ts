import { describe, expect, test } from "vitest"

// Drive the public barrel so index.ts appears in lcov.
import * as chatResponses from "../../../src/protocols/chat-responses"

describe("chat-responses barrel", () => {
  test("exports classifiers and translators", () => {
    expect(typeof chatResponses.isResponsesOnly).toBe("function")
    expect(typeof chatResponses.chatRequestToResponses).toBe("function")
    expect(typeof chatResponses.responsesJsonToChatCompletion).toBe("function")
    expect(typeof chatResponses.adaptResponsesEventToChatChunks).toBe("function")
    expect(typeof chatResponses.isResponsesFailure).toBe("function")
    expect(typeof chatResponses.assertChatViaResponsesSupported).toBe("function")
    expect(chatResponses.isResponsesOnly(["/responses"])).toBe(true)
  })
})
