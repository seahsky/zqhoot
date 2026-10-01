// The quiz the test creates: mostly single choice, some true/false and one poll in ten. Every
// question is timed at the same limit. The shape is validated against the protocol's `QuizInput`
// schema in test/quiz.test.js, so a schema change breaks a unit test instead of a load run.

const pad = (n) => String(n).padStart(2, '0');

/** Question type by index: 7 single, 2 true/false and 1 poll in every ten. */
export function questionType(index) {
  const slot = index % 10;
  if (slot === 2 || slot === 7) return 'truefalse';
  if (slot === 5) return 'poll';
  return 'single';
}

const pointsFor = (index) => (index % 4 === 3 ? 2 : 1);

export function buildQuiz({ questions, timeLimit, readSeconds }) {
  const list = [];
  for (let index = 0; index < questions; index++) {
    const type = questionType(index);
    const id = `loadq${pad(index)}`;
    const base = {
      id,
      prompt: `Question ${index + 1}: pick the first answer`,
      timeLimitSec: timeLimit,
    };
    const options = (count) =>
      ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']
        .slice(0, count)
        .map((text, i) => ({ id: `${id}-${'abcdef'[i]}`, text }));
    if (type === 'single') {
      const choices = options(4);
      list.push({
        ...base,
        type,
        options: choices,
        correctOptionId: choices[0].id,
        points: pointsFor(index),
      });
    } else if (type === 'truefalse') {
      list.push({ ...base, type, correct: true, points: pointsFor(index) });
    } else {
      list.push({ ...base, type, options: options(3) });
    }
  }
  return {
    title: 'Load test quiz',
    questions: list,
    settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds },
  };
}

/** Which questions are followed by a leaderboard: scored types with a multiplier above 0. */
export const scoredFlags = (quiz) =>
  quiz.questions.map((q) => (q.type === 'single' || q.type === 'truefalse') && q.points > 0);
