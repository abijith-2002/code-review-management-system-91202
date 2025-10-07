#!/bin/bash
cd /home/kavia/workspace/code-generation/code-review-management-system-91202/code_review_backend
npm run lint
LINT_EXIT_CODE=$?
if [ $LINT_EXIT_CODE -ne 0 ]; then
  exit 1
fi

