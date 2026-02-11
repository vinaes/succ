/**
 * LongMemEval evaluator — official evaluation prompts
 *
 * Prompts copied EXACTLY from the official benchmark:
 * https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py
 *
 * Judge: always GPT-4o via OpenRouter for consistency with official results.
 */

import { callLLMChat, type ChatMessage } from '../../../src/lib/llm.js';
import type { QuestionType } from './types.js';

const JUDGE_CONFIG = {
  backend: 'openrouter' as const,
  openrouterModel: 'openai/gpt-4o',
};

/**
 * Get the official evaluation prompt for a question type.
 * These match evaluate_qa.py from the LongMemEval repo exactly.
 */
function getEvalPrompt(
  questionType: QuestionType,
  question: string,
  answer: string,
  hypothesis: string,
  isAbstention: boolean,
): string {
  if (isAbstention) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: ${question}

Explanation: ${answer}

Model Response: ${hypothesis}

Does the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }

  switch (questionType) {
    case 'single-session-user':
    case 'single-session-assistant':
    case 'multi-session':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${hypothesis}

Is the model response correct? Answer yes or no only.`;

    case 'temporal-reasoning':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${hypothesis}

Is the model response correct? Answer yes or no only.`;

    case 'knowledge-update':
      return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: ${question}

Correct Answer: ${answer}

Model Response: ${hypothesis}

Is the model response correct? Answer yes or no only.`;

    case 'single-session-preference':
      return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: ${question}

Rubric: ${answer}

Model Response: ${hypothesis}

Is the model response correct? Answer yes or no only.`;

    default:
      throw new Error(`Unknown question type: ${questionType}`);
  }
}

/**
 * Evaluate a model's answer using GPT-4o as judge.
 * Returns true if the answer is correct according to the official LongMemEval criteria.
 */
export async function evaluate(
  questionType: QuestionType,
  questionId: string,
  question: string,
  expectedAnswer: string,
  hypothesis: string,
): Promise<boolean> {
  const isAbstention = questionId.endsWith('_abs');
  const prompt = getEvalPrompt(questionType, question, expectedAnswer, hypothesis, isAbstention);

  const messages: ChatMessage[] = [
    { role: 'user', content: prompt },
  ];

  const response = await callLLMChat(messages, {
    temperature: 0,
    maxTokens: 10,
    useChatLLM: false,
  }, JUDGE_CONFIG);

  const normalized = response.toLowerCase().trim();
  return normalized === 'yes' || normalized.startsWith('yes.');
}
