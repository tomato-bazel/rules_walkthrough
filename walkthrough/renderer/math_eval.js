// Compile a walkthrough.v1.MathExpression into a
// JavaScript function. Walkthroughs are author-controlled — the
// `new Function` path is safe in this context.
//
// Usage:
//   import { compile } from "./math_eval.js";
//   const f = compile({ vars: ["x"], body: "sin(x) * exp(-x*0.1)" });
//   const y = f({ x: 1.5 });
//
// For untrusted expressions, swap in a real parser/interpreter (see
// roadmap A4 follow-up). The same MathExpression body would then
// also be codegen-able to WGSL for WebGPU shader evaluation.

const _BUILTINS = {
  pi: Math.PI,
  e: Math.E,
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
  sqrt: Math.sqrt, cbrt: Math.cbrt,
  abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, trunc: Math.trunc,
  min: Math.min, max: Math.max,
  pow: Math.pow, hypot: Math.hypot,
  mod: (a, b) => ((a % b) + b) % b,
};

const _BUILTIN_NAMES = Object.keys(_BUILTINS);
const _BUILTIN_VALUES = Object.values(_BUILTINS);

export function compile(expr) {
  const vars = (expr && expr.vars) || [];
  const body = (expr && expr.body) || "0";

  // Construct: function (builtins..., ...vars) { "use strict"; return (BODY); }
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(
      ..._BUILTIN_NAMES,
      ...vars,
      `"use strict"; return (${body});`,
    );
  } catch (e) {
    throw new Error(`MathExpression compile failed for "${body}": ${e.message}`);
  }

  return (varValues = {}) => {
    const args = _BUILTIN_VALUES.slice();
    for (const v of vars) {
      args.push(varValues[v] ?? 0);
    }
    return fn(...args);
  };
}

// Convenience: sample an ExpressionPlot into (xs, ys) arrays. The
// expression's first var is taken as the independent variable.
export function sampleExpressionPlot(plot) {
  const { expression, min = 0, max = 1, samples = 100 } = plot;
  const vars = (expression && expression.vars) || [];
  if (vars.length === 0) {
    throw new Error("ExpressionPlot: expression must have at least one var");
  }
  const f = compile(expression);
  const indep = vars[0];
  const N = Math.max(2, Math.floor(samples));
  const xs = new Array(N);
  const ys = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = min + (i / (N - 1)) * (max - min);
    xs[i] = t;
    try {
      ys[i] = f({ [indep]: t });
    } catch (e) {
      ys[i] = NaN;
    }
  }
  return { xs, ys };
}
