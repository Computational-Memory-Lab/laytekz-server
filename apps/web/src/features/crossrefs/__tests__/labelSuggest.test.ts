import { describe, expect, it } from 'vitest';
import { labelPlan, labelsInText, slugify, suggestedName, uniqueName } from '../labelSuggest';

/** The plan for the `|` in `marked`, and the text with the label written in (or the selected existing label). */
function place(marked: string, taken: string[] = []) {
  const text = marked.replace('|', '');
  const plan = labelPlan(text, marked.indexOf('|'));
  if (plan.existing) return { plan, result: `selected ${text.slice(plan.existing.from, plan.existing.to)}` };
  const name = uniqueName(plan.prefix, plan.slug, new Set([...labelsInText(text), ...taken]));
  return { plan, result: text.slice(0, plan.at) + plan.pad + `\\label{${name}}` + text.slice(plan.at) };
}

describe('slugs', () => {
  it('de-TeXes, folds accents and drops stop words', () => {
    expect(slugify('Mean \\emph{reaction} times ($ms$) of the participants')).toBe('mean-reaction-times-participants');
    expect(slugify('Méthode générale')).toBe('methode-generale');
    expect(slugify('The effect of \\textbf{caffeine} on sleep in older adults and children')).toBe('effect-caffeine-sleep-older');
    expect(slugify('a'.repeat(40))).toBe('a'.repeat(32));
  });

  it('makes names unique with -2, and numbers an empty slug', () => {
    expect(uniqueName('fig:', 'rt', new Set(['fig:rt', 'fig:rt-2']))).toBe('fig:rt-3');
    expect(uniqueName('eq:', '', new Set(['eq:1']))).toBe('eq:2');
    expect(labelsInText('\\label{a} % \\label{b}\n\\label{ c }')).toEqual(['a', 'c']);
  });
});

describe('floats', () => {
  const figure = (body: string) => `\\begin{figure}[htbp]\n${body}\n\\end{figure}`;

  it('puts the label after the caption, even when the caret is before it, and says so', () => {
    const { plan, result } = place(figure('|\\includegraphics{rt.pdf}\n\\caption{Mean reaction times}'));
    expect(result).toBe(figure('\\includegraphics{rt.pdf}\n\\caption{Mean reaction times}\\label{fig:mean-reaction-times}'));
    expect(plan.moved).toBe(true);
    expect(plan.what).toBe('figure');
  });

  it('uses the short caption, and tables get tab:', () => {
    const { result, plan } = place('\\begin{table}\n\\caption[Demographics]{Participant demographics by group}|\n\\end{table}');
    expect(result).toBe('\\begin{table}\n\\caption[Demographics]{Participant demographics by group}\\label{tab:demographics}\n\\end{table}');
    expect(plan.moved).toBe(false);
  });

  it('falls back to the graphic\u2019s file name without a caption', () => {
    expect(place(figure('\\includegraphics[width=\\linewidth]{figs/rt_by_age.pdf}|')).result).toContain('\\label{fig:rt-age}');
  });

  it('selects a label the float already has', () => {
    expect(place(figure('\\caption{A}\\label{fig:a}\n|')).result).toBe('selected fig:a');
  });

  it('a subfigure uses its own caption, the outer figure ignores it', () => {
    const text = '\\begin{figure}\n\\begin{subfigure}{.5\\linewidth}\\caption{Left panel}|\\end{subfigure}\n\\caption{Both panels}\n\\end{figure}';
    expect(place(text).result).toContain('\\caption{Left panel}\\label{fig:left-panel}');
    const outer = text.replace('|', '').replace('\\caption{Both', '|\\caption{Both');
    expect(place(outer).result).toContain('\\caption{Both panels}\\label{fig:both-panels}');
  });
});

describe('equations, theorems and items', () => {
  it('equations: the next free number, at the end of the caret\u2019s row', () => {
    const { result } = place('\\begin{align}\n  a &= b |% note\n  \\\\\n  c &= d\n\\end{align}', ['eq:1']);
    expect(result).toBe('\\begin{align}\n  a &= b \\label{eq:2} % note\n  \\\\\n  c &= d\n\\end{align}');
    expect(place('\\begin{equation}\n  E = mc^2|\n\\end{equation}').result).toBe('\\begin{equation}\n  E = mc^2 \\label{eq:1}\n\\end{equation}');
    expect(place('\\begin{align}\n a \\label{eq:x} \\\\ b|\n\\end{align}').result).toContain('b \\label{eq:1}');
  });

  it('theorems: right after \\begin, prefix from \\newtheorem\u2019s printed name, slug from the note', () => {
    const pre = '\\newtheorem{hyp}{Hypothesis}\n';
    expect(place(`${pre}\\begin{hyp}[Mood congruence]\nPeople |remember more.\n\\end{hyp}`).result)
      .toBe(`${pre}\\begin{hyp}[Mood congruence]\\label{hyp:mood-congruence}\nPeople remember more.\n\\end{hyp}`);
    expect(place('\\begin{lemma}|x\\end{lemma}').result).toBe('\\begin{lemma}\\label{lem:1}x\\end{lemma}');
  });

  it('enumerate: right after the caret\u2019s \\item', () => {
    expect(place('\\begin{enumerate}\n\\item First step\n\\item Second |step\n\\end{enumerate}').result)
      .toBe('\\begin{enumerate}\n\\item First step\n\\item \\label{item:second-step} Second step\n\\end{enumerate}');
  });
});

describe('sections', () => {
  it('labels the section the caret is in, on the heading\u2019s line', () => {
    const { result, plan } = place('\\section{Method}\nWe asked |people.');
    expect(result).toBe('\\section{Method}\\label{sec:method}\nWe asked people.');
    expect(plan.moved).toBe(true);
    expect(place('\\section{Method}|').plan.moved).toBe(false);
  });

  it('chapters get ch:, headings after \\appendix get app:', () => {
    expect(place('\\chapter{Results}\n|').result).toContain('\\label{ch:results}');
    expect(place('\\appendix\n\\section{Stimulus lists}\n|').result).toContain('\\label{app:stimulus-lists}');
  });

  it('selects the heading\u2019s label on the next line, and ignores a commented heading', () => {
    expect(place('\\section{Method}\n\\label{sec:m}\nText|').result).toBe('selected sec:m');
    expect(place('\\section{Intro}\n% \\section{Old}\nText|').result).toContain('\\label{sec:intro}');
  });

  it('suggests the name for the \\label{ completion', () => {
    const text = '\\begin{figure}\\caption{Accuracy}\\label{}\\end{figure}';
    expect(suggestedName(text, text.indexOf('{}') + 1, new Set(['fig:accuracy']))).toBe('fig:accuracy-2');
  });
});
