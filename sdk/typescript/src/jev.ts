import { environmentEntry } from "./auth.js";
import { CodexSecurityError } from "./errors.js";

export const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";

export interface JevChoiceQuestion {
  instructions: unknown;
  criteria: Readonly<Record<string, unknown>>;
}

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevChoiceClient {
  choose(
    state: unknown,
    questions: Readonly<Record<string, JevChoiceQuestion>>,
  ): Promise<Record<string, JevChoiceAnswer>>;
}

type JevFetch = typeof globalThis.fetch;

function requiredChoiceAnswer(
  value: unknown,
  labels: ReadonlySet<string>,
): JevChoiceAnswer {
  if (value === null || typeof value !== "object") {
    throw new CodexSecurityError("Jev returned an invalid Choice answer.");
  }
  const answer = value as Record<string, unknown>;
  if (
    answer["type"] !== "choice" ||
    typeof answer["choice"] !== "string" ||
    !labels.has(answer["choice"]) ||
    typeof answer["confidence"] !== "number" ||
    !Number.isFinite(answer["confidence"]) ||
    answer["confidence"] < 0 ||
    answer["confidence"] > 1 ||
    answer["probabilities"] === null ||
    typeof answer["probabilities"] !== "object"
  ) {
    throw new CodexSecurityError("Jev returned an invalid Choice answer.");
  }
  const probabilities: Record<string, number> = {};
  for (const label of labels) {
    const probability = (answer["probabilities"] as Record<string, unknown>)[
      label
    ];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      throw new CodexSecurityError("Jev returned invalid Choice probabilities.");
    }
    probabilities[label] = probability;
  }
  return {
    choice: answer["choice"],
    probabilities,
    confidence: answer["confidence"],
  };
}

/**
 * Create the Jev decision client when TypeSafe credentials are available.
 *
 * Jev is an optimization layer in Codex Security. Callers intentionally keep
 * their existing System-2 path as the fallback when this returns undefined or
 * when a Jev request fails.
 *
 * @internal
 */
export function createJevChoiceClient(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  fetchImpl: JevFetch = globalThis.fetch,
): JevChoiceClient | undefined {
  const apiKey = environmentEntry(environment, "TYPESAFE_API_KEY")?.trim();
  if (!apiKey) return undefined;
  const baseURL =
    environmentEntry(environment, "TYPESAFE_BASE_URL")?.trim() ||
    DEFAULT_JEV_BASE_URL;
  const model =
    environmentEntry(environment, "TYPESAFE_DEFAULT_MODEL")?.trim() ||
    DEFAULT_JEV_MODEL;

  return {
    async choose(state, questions) {
      signal?.throwIfAborted();
      if (Object.keys(questions).length === 0) return {};
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseURL.replace(/\/$/u, "")}/v1/systemone`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              state,
              model,
              questions: Object.fromEntries(
                Object.entries(questions).map(([name, question]) => [
                  name,
                  {
                    type: "choice",
                    instructions: question.instructions,
                    criteria: question.criteria,
                  },
                ]),
              ),
            }),
            signal,
          },
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new CodexSecurityError("Jev decision request failed.", {
          cause: error,
        });
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new CodexSecurityError(
          `Jev decision request failed (HTTP ${response.status}).`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new CodexSecurityError("Jev returned invalid JSON.", {
          cause: error,
        });
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        (payload as Record<string, unknown>)["answers"] === null ||
        typeof (payload as Record<string, unknown>)["answers"] !== "object"
      ) {
        throw new CodexSecurityError("Jev returned an invalid response.");
      }
      const rawAnswers = (payload as Record<string, unknown>)[
        "answers"
      ] as Record<string, unknown>;
      const answers: Record<string, JevChoiceAnswer> = {};
      for (const [name, question] of Object.entries(questions)) {
        answers[name] = requiredChoiceAnswer(
          rawAnswers[name],
          new Set(Object.keys(question.criteria)),
        );
      }
      return answers;
    },
  };
}
