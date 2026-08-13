import crypto from 'node:crypto';

export const REVIEW_PLAIN_TEXT_MODEL = 'agentify_review_plain_text_v1';
export const REVIEW_CAUSAL_SUBMISSION_MODEL = 'agentify_review_causal_submission_v1';

// Browser editing surfaces expose line breaks as LF even when the source uses
// CRLF or a lone CR. No other whitespace or Unicode normalization is applied.
export function canonicalizeReviewPlainText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n');
}

export function browserSpaceRebalanceSite(expectedCodePoints, index) {
  let start = index;
  let end = index + 1;
  while (start > 0 && expectedCodePoints[start - 1] === ' ') start -= 1;
  while (end < expectedCodePoints.length && expectedCodePoints[end] === ' ') end += 1;
  const atLineStart = start === 0 || expectedCodePoints[start - 1] === '\n';
  const atLineEnd = end === expectedCodePoints.length || expectedCodePoints[end] === '\n';
  return atLineStart || atLineEnd || end - start > 1;
}

// Blink rebalances otherwise-collapsible ASCII spaces to NBSP inside
// contenteditable DOM. Recover only that length-preserving transformation and
// only at a leading, trailing, or repeated ASCII-space run. Every other code
// point remains exact. If the source itself contains NBSP, recovery is disabled
// and the DOM must match it byte-for-code-point after line-ending canonicalization.
export function compareReviewPlainText(expectedRaw, observedRaw) {
  const expected = canonicalizeReviewPlainText(expectedRaw);
  const observed = canonicalizeReviewPlainText(observedRaw);
  const base = {
    textModel: REVIEW_PLAIN_TEXT_MODEL,
    expectedRawLength: String(expectedRaw ?? '').length,
    expectedCanonicalLength: expected.length,
    observedRawLength: String(observedRaw ?? '').length,
    observedCanonicalLength: observed.length,
    lineEndingCanonicalized: expected !== String(expectedRaw ?? '') || observed !== String(observedRaw ?? ''),
    browserSpaceRebalanceCount: 0,
    mismatchCount: 0,
    firstMismatchCodePointIndex: null,
    firstMismatchExpectedCodePoint: null,
    firstMismatchObservedCodePoint: null,
    mismatchClass: null,
    canonicalExpectedText: expected,
    canonicalObservedText: observed
  };
  if (expected === observed) return { ...base, ok: true, identityMode: 'canonical_exact' };

  const expectedCodePoints = Array.from(expected);
  const observedCodePoints = Array.from(observed);
  if (expectedCodePoints.length !== observedCodePoints.length) {
    return {
      ...base,
      ok: false,
      identityMode: 'mismatch',
      mismatchClass: 'code_point_length_mismatch',
      expectedCodePointLength: expectedCodePoints.length,
      observedCodePointLength: observedCodePoints.length
    };
  }

  const sourceContainsNbsp = expectedCodePoints.includes('\u00a0');
  const hasNonWhitespaceContent = expectedCodePoints.some((codePoint) => codePoint !== ' ' && codePoint !== '\n');
  const recovered = [...observedCodePoints];
  let firstUnhandled = null;
  let mismatchCount = 0;
  let rebalanceCount = 0;
  for (let index = 0; index < expectedCodePoints.length; index += 1) {
    const expectedCodePoint = expectedCodePoints[index];
    const observedCodePoint = observedCodePoints[index];
    if (expectedCodePoint === observedCodePoint) continue;
    mismatchCount += 1;
    if (
      !sourceContainsNbsp &&
      hasNonWhitespaceContent &&
      expectedCodePoint === ' ' &&
      observedCodePoint === '\u00a0' &&
      browserSpaceRebalanceSite(expectedCodePoints, index)
    ) {
      recovered[index] = ' ';
      rebalanceCount += 1;
      continue;
    }
    firstUnhandled ||= { index, expectedCodePoint, observedCodePoint };
  }
  const recoveredText = recovered.join('');
  if (!firstUnhandled && rebalanceCount > 0 && recoveredText === expected) {
    return {
      ...base,
      ok: true,
      identityMode: 'browser_space_rebalanced',
      browserSpaceRebalanceCount: rebalanceCount,
      mismatchCount,
      canonicalObservedText: recoveredText
    };
  }
  const first = firstUnhandled || {
    index: 0,
    expectedCodePoint: expectedCodePoints[0] || '',
    observedCodePoint: observedCodePoints[0] || ''
  };
  return {
    ...base,
    ok: false,
    identityMode: 'mismatch',
    browserSpaceRebalanceCount: rebalanceCount,
    mismatchCount,
    firstMismatchCodePointIndex: first.index,
    firstMismatchExpectedCodePoint: first.expectedCodePoint
      ? `U+${first.expectedCodePoint.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      : null,
    firstMismatchObservedCodePoint: first.observedCodePoint
      ? `U+${first.observedCodePoint.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      : null,
    mismatchClass: sourceContainsNbsp
      ? 'source_nbsp_requires_exact'
      : hasNonWhitespaceContent
        ? 'non_reversible_code_point_mismatch'
        : 'browser_space_rebalance_without_ascii_whitespace'
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function reviewPlainTextIdentity(value) {
  const raw = String(value ?? '');
  const canonical = canonicalizeReviewPlainText(raw);
  return {
    textModel: REVIEW_PLAIN_TEXT_MODEL,
    sourceSha256: sha256(raw),
    canonicalSha256: sha256(canonical),
    sourceLength: raw.length,
    canonicalLength: canonical.length,
    lineEndingCanonicalized: raw !== canonical
  };
}

// A strict submission is causally bound to the exact composer text at the
// unique Send boundary.  The persisted baseline digest prevents a recovery
// observer from silently widening that boundary to an arbitrary visible turn.
export function reviewBaselineMessageIdsSha256(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.some((id) => typeof id !== 'string' || !id)) return null;
  return sha256(JSON.stringify(messageIds));
}

export function validateReviewCausalSubmissionReceipt(receipt, { prompt, baselineMessageIds } = {}) {
  const identity = reviewPlainTextIdentity(prompt);
  const baselineMessageIdsSha256 = reviewBaselineMessageIdsSha256(baselineMessageIds);
  return !!receipt &&
    receipt.ok === true &&
    receipt.persisted === true &&
    receipt.identityModel === REVIEW_CAUSAL_SUBMISSION_MODEL &&
    typeof receipt.operationId === 'string' && receipt.operationId.length > 0 &&
    receipt.sendActionCount === 1 &&
    receipt.clickCount === 1 &&
    receipt.sourceSha256 === identity.sourceSha256 &&
    receipt.canonicalPromptSha256 === identity.canonicalSha256 &&
    baselineMessageIdsSha256 !== null &&
    receipt.baselineMessageIdsSha256 === baselineMessageIdsSha256;
}

export function compareReviewPlainTextIdentity(expectedRaw, observedRaw, sha256Fn = sha256) {
  const comparison = compareReviewPlainText(expectedRaw, observedRaw);
  const raw = String(expectedRaw ?? '');
  const canonical = canonicalizeReviewPlainText(raw);
  const source = {
    textModel: REVIEW_PLAIN_TEXT_MODEL,
    sourceSha256: sha256Fn(raw),
    canonicalSha256: sha256Fn(canonical),
    sourceLength: raw.length,
    canonicalLength: canonical.length,
    lineEndingCanonicalized: raw !== canonical
  };
  const observedRawText = String(observedRaw ?? '');
  const observedCanonicalText = comparison.canonicalObservedText;
  const observedRawSha256 = sha256Fn(observedRawText);
  const observedCanonicalSha256 = sha256Fn(observedCanonicalText);
  const accepted = comparison.ok === true && source.canonicalSha256 === observedCanonicalSha256;
  return {
    comparison,
    source,
    observedRawSha256,
    observedCanonicalSha256,
    accepted
  };
}

export function safeReviewPlainTextComparison(expectedRaw, observedRaw) {
  const {
    comparison,
    source,
    observedRawSha256,
    observedCanonicalSha256,
    accepted
  } = compareReviewPlainTextIdentity(expectedRaw, observedRaw);
  const safe = {
    ...comparison,
    ok: accepted,
    sourceSha256: source.sourceSha256,
    canonicalPromptSha256: source.canonicalSha256,
    observedRawSha256,
    observedCanonicalSha256
  };
  delete safe.canonicalExpectedText;
  delete safe.canonicalObservedText;
  return safe;
}
