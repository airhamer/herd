# Quality bench data: third-party notices

The Quality bench (`server/collectors/QualityBench.js`, #42) bundles two
third-party evaluation samples. Both are published under the MIT licence,
which is compatible with Herd's MIT licence. The samples were taken from the
original publishers, not from any other benchmark tool.

Every other Quality bench item (QA, reasoning, arithmetic chain, state
tracking, instruction following, long-context recall) is written or generated
by Herd (`server/collectors/quality/`) and is covered by Herd's own licence.

## GSM8K: `gsm8k-test-200.json`

- Source: <https://github.com/openai/grade-school-math>, file
  `grade_school_math/data/test.jsonl`, the first 200 problems in file order.
- Changes: only the question and the final answer (the number after `####`,
  thousands separators removed) are kept. The worked solutions are dropped.
- Paper: Cobbe et al., "Training Verifiers to Solve Math Word Problems" (2021).

```
MIT License

Copyright (c) 2021 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MMLU: `mmlu-dev-285.json`

- Source: <https://github.com/hendrycks/test> (MMLU). This is the `dev` split:
  5 questions for each of the 57 subjects, 285 in all. It was read from the
  `cais/mmlu` mirror on Hugging Face (configuration `all`, split `dev`), which
  republishes the same MIT-licensed data.
- Changes: none to the question or choice text. The answer index is stored as
  the letter A–D.
- Paper: Hendrycks et al., "Measuring Massive Multitask Language
  Understanding" (ICLR 2021).

```
MIT License

Copyright (c) 2020 Dan Hendrycks

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
