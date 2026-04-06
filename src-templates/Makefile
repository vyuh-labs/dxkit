.PHONY: help setup setup-ci doctor dev stop clean build deploy
.PHONY: test test-unit test-integration test-coverage test-quick
.PHONY: lint format format-check quality quality-fix
.PHONY: quality-config quality-disable quality-enable quality-reset
.PHONY: quality-strict quality-standard quality-relaxed quality-off quality-presets
.PHONY: coverage-disable coverage-enable coverage-set
.PHONY: info config
.PHONY: lang-add lang-remove lang-list
.PHONY: sync sync-preview
.PHONY: sync-template sync-template-check sync-template-preview sync-template-apply sync-template-status
.PHONY: docs docs-serve docs-check
.PHONY: generate generate-errors validate validate-errors validate-codegen
.PHONY: ai-start ai-step ai-checkpoint ai-history
.PHONY: session-start session-end session-commit session-push
.PHONY: check pre-commit fix
.PHONY: secrets-pull secrets-show

# Colors for output
CYAN := \033[36m
GREEN := \033[32m
YELLOW := \033[33m
DIM := \033[2m
RESET := \033[0m

help: ## Show this help message
	@echo "$(CYAN)Available commands:$(RESET)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ============================================================================
# Setup & Installation
# ============================================================================

setup: ## Interactive setup for new developers
	@./.project/scripts/setup/interactive-setup.sh

doctor: ## Diagnose common setup issues
	@./.project/scripts/setup/doctor.sh

setup-ci: ## Non-interactive setup for CI/CD
	@echo "$(CYAN)Setting up for CI...$(RESET)"
	@if [ -d "services/go/user-service" ]; then make -C services/go/user-service setup; fi
	@if [ -d "services/python/langgraph-service" ]; then make -C services/python/langgraph-service setup-ci; fi

# ============================================================================
# Project Configuration
# ============================================================================

info: ## Show project configuration dashboard
	@python3 .project/config/project_config.py info

config: ## Interactive project configuration editor
	@python3 .project/config/edit_config.py

# ============================================================================
# Development
# ============================================================================

dev: ## Start all services in development mode
	@echo "$(CYAN)Starting all services...$(RESET)"
	@docker-compose up

stop: ## Stop all services
	@echo "$(CYAN)Stopping all services...$(RESET)"
	@docker-compose down

# ============================================================================
# Testing
# ============================================================================

test: ## Run all tests (report: tmp/reports/test-report.md)
	@./.project/scripts/test/run-all.sh

test-unit: ## Run only unit tests (fast)
	@./.project/scripts/test/run-quick.sh

test-integration: ## Run only integration tests
	@if [ -d "services/go/user-service" ]; then make -C services/go/user-service test-integration; fi
	@if [ -d "services/python/langgraph-service" ]; then make -C services/python/langgraph-service test-integration; fi

test-coverage: ## Run tests with detailed coverage report
	@echo "$(CYAN)Running tests with coverage...$(RESET)"
	@echo "$(CYAN)Go coverage...$(RESET)"
	@if find . -name "go.mod" -type f | grep -q .; then \
		go test ./... -coverprofile=coverage.out -covermode=atomic; \
		go tool cover -html=coverage.out -o coverage.html; \
		echo "$(GREEN)Coverage report: coverage.html$(RESET)"; \
	fi
	@echo "$(CYAN)Python coverage...$(RESET)"
	@for dir in $$(find pkg/python services/python -name "pyproject.toml" -o -name "setup.py" 2>/dev/null | xargs -r dirname | sort -u); do \
		(cd $$dir && pytest --cov=. --cov-report=html 2>/dev/null) || true; \
	done
	@echo "$(GREEN)✅ Coverage reports generated$(RESET)"

test-quick: test-unit ## Alias for test-unit

# ============================================================================
# Code Generation
# ============================================================================

generate: ## Generate all code (error codes, etc.)
	@./.project/scripts/codegen/generate-all.sh

generate-errors: ## Generate error codes from YAML (Go + Python)
	@./.project/scripts/codegen/generate-errors.sh

validate: ## Validate all generated code is up-to-date
	@./.project/scripts/codegen/validate-all.sh

validate-errors: validate ## Alias for validate

validate-codegen: validate ## Alias for validate

# ============================================================================
# Code Quality
# ============================================================================

quality: ## Run all quality checks (report: tmp/reports/quality-report.md)
	@./.project/scripts/quality/run-all.sh

quality-fix: ## Auto-fix quality issues where possible
	@./.project/scripts/quality/fix-all.sh

lint: ## Lint all code (included in quality report)
	@echo "$(CYAN)Linting all code...$(RESET)"
	@./.project/scripts/quality/lint-go.sh
	@./.project/scripts/quality/lint-python.sh
	@echo "$(GREEN)✅ Linting complete$(RESET)"

format: ## Format all code
	@echo "$(CYAN)Formatting all code...$(RESET)"
	@echo "$(CYAN)Formatting Go code...$(RESET)"
	@if find . -name "*.go" -type f -not -path "./v0/*" | grep -q .; then \
		gofmt -w $$(find . -name "*.go" -type f -not -path "./v0/*"); \
		goimports -w $$(find . -name "*.go" -type f -not -path "./v0/*") 2>/dev/null || true; \
	fi
	@echo "$(CYAN)Formatting Python code...$(RESET)"
	@if command -v black >/dev/null 2>&1; then \
		find pkg/python services/python -name "*.py" -type f 2>/dev/null | xargs -r black 2>/dev/null || true; \
	fi
	@echo "$(GREEN)✅ All code formatted$(RESET)"

format-check: ## Check formatting without making changes
	@if [ -d "services/go/user-service" ]; then make -C services/go/user-service format-check; fi
	@if [ -d "services/python/langgraph-service" ]; then make -C services/python/langgraph-service format-check; fi

# ============================================================================
# Quality Configuration (toggle checks on/off)
# ============================================================================

QUALITY_CONFIG := .quality.env

quality-config: ## Show current quality configuration
	@echo "$(CYAN)Quality Configuration$(RESET)"
	@echo "====================="
	@if [ -f "$(QUALITY_CONFIG)" ]; then \
		cat $(QUALITY_CONFIG); \
	else \
		echo "No custom configuration (using defaults)"; \
		echo ""; \
		echo "Defaults:"; \
		echo "  SKIP_QUALITY_CHECKS=false"; \
		echo "  SKIP_COVERAGE_CHECK=false"; \
		echo "  COVERAGE_THRESHOLD=80"; \
	fi
	@echo ""
	@echo "$(CYAN)To modify, run:$(RESET)"
	@echo "  make quality-disable    # Disable quality checks"
	@echo "  make quality-enable     # Enable quality checks"
	@echo "  make coverage-disable   # Disable coverage threshold"
	@echo "  make coverage-set PERCENT=70  # Set coverage threshold"

quality-disable: ## Disable quality checks locally
	@echo "SKIP_QUALITY_CHECKS=true" > $(QUALITY_CONFIG)
	@if [ -f "$(QUALITY_CONFIG)" ] && grep -q "SKIP_COVERAGE_CHECK" $(QUALITY_CONFIG); then \
		true; \
	else \
		echo "SKIP_COVERAGE_CHECK=false" >> $(QUALITY_CONFIG); \
	fi
	@echo "$(GREEN)✅ Quality checks disabled$(RESET)"
	@echo "$(CYAN)Note: To disable in CI, set repository variable SKIP_QUALITY_CHECKS=true$(RESET)"

quality-enable: ## Enable quality checks locally
	@if [ -f "$(QUALITY_CONFIG)" ]; then \
		sed -i 's/SKIP_QUALITY_CHECKS=true/SKIP_QUALITY_CHECKS=false/' $(QUALITY_CONFIG); \
	fi
	@echo "$(GREEN)✅ Quality checks enabled$(RESET)"

coverage-disable: ## Disable coverage threshold checks
	@if [ -f "$(QUALITY_CONFIG)" ]; then \
		if grep -q "SKIP_COVERAGE_CHECK" $(QUALITY_CONFIG); then \
			sed -i 's/SKIP_COVERAGE_CHECK=.*/SKIP_COVERAGE_CHECK=true/' $(QUALITY_CONFIG); \
		else \
			echo "SKIP_COVERAGE_CHECK=true" >> $(QUALITY_CONFIG); \
		fi; \
	else \
		echo "SKIP_QUALITY_CHECKS=false" > $(QUALITY_CONFIG); \
		echo "SKIP_COVERAGE_CHECK=true" >> $(QUALITY_CONFIG); \
	fi
	@echo "$(GREEN)✅ Coverage threshold checks disabled$(RESET)"

coverage-enable: ## Enable coverage threshold checks
	@if [ -f "$(QUALITY_CONFIG)" ]; then \
		sed -i 's/SKIP_COVERAGE_CHECK=true/SKIP_COVERAGE_CHECK=false/' $(QUALITY_CONFIG); \
	fi
	@echo "$(GREEN)✅ Coverage threshold checks enabled$(RESET)"

coverage-set: ## Set coverage threshold (usage: make coverage-set PERCENT=80)
ifndef PERCENT
	@echo "$(CYAN)Usage: make coverage-set PERCENT=80$(RESET)"
	@exit 1
endif
	@if [ -f "$(QUALITY_CONFIG)" ]; then \
		if grep -q "COVERAGE_THRESHOLD" $(QUALITY_CONFIG); then \
			sed -i 's/COVERAGE_THRESHOLD=.*/COVERAGE_THRESHOLD=$(PERCENT)/' $(QUALITY_CONFIG); \
		else \
			echo "COVERAGE_THRESHOLD=$(PERCENT)" >> $(QUALITY_CONFIG); \
		fi; \
	else \
		echo "SKIP_QUALITY_CHECKS=false" > $(QUALITY_CONFIG); \
		echo "SKIP_COVERAGE_CHECK=false" >> $(QUALITY_CONFIG); \
		echo "COVERAGE_THRESHOLD=$(PERCENT)" >> $(QUALITY_CONFIG); \
	fi
	@echo "$(GREEN)✅ Coverage threshold set to $(PERCENT)%$(RESET)"
	@echo "$(CYAN)Note: Run 'make sync' to apply changes to config files$(RESET)"

quality-reset: ## Reset quality configuration to defaults
	@rm -f $(QUALITY_CONFIG)
	@echo "$(GREEN)✅ Quality configuration reset to defaults$(RESET)"

# ============================================================================
# Quality Presets (new config system)
# ============================================================================

quality-presets: ## List available quality presets
	@python3 .project/config/project_config.py preset

quality-strict: ## Apply strict quality preset (90%+ coverage, all checks)
	@python3 .project/config/project_config.py preset strict

quality-standard: ## Apply standard quality preset (80% coverage, balanced)
	@python3 .project/config/project_config.py preset standard

quality-relaxed: ## Apply relaxed quality preset (50% coverage, minimal)
	@python3 .project/config/project_config.py preset relaxed

quality-off: ## Disable all quality checks
	@python3 .project/config/project_config.py preset off

# ============================================================================
# Language Management
# ============================================================================

lang-list: ## List available languages and their status
	@python3 .project/config/project_config.py lang-list

lang-add: ## Add a language (usage: make lang-add LANG=python)
ifndef LANG
	@echo "$(CYAN)Usage: make lang-add LANG=<language>$(RESET)"
	@echo "$(CYAN)Languages: python, go, node, rust$(RESET)"
	@exit 1
endif
	@python3 .project/config/project_config.py lang-add $(LANG)

lang-remove: ## Remove a language (usage: make lang-remove LANG=go)
ifndef LANG
	@echo "$(CYAN)Usage: make lang-remove LANG=<language>$(RESET)"
	@exit 1
endif
	@python3 .project/config/project_config.py lang-remove $(LANG)

# ============================================================================
# Config Sync (sync .project.yaml to language files)
# ============================================================================

sync: ## Sync project config to language files (pyproject.toml, go.mod, etc.)
	@python3 .project/config/project_config.py sync

sync-preview: ## Preview config sync changes (dry run)
	@python3 .project/config/project_config.py sync --dry-run

# ============================================================================
# Documentation
# ============================================================================

docs: ## Generate all documentation (API docs, etc.)
	@./.project/scripts/docs/generate-all.sh

docs-serve: ## Serve documentation locally
	@./.project/scripts/docs/serve.sh

docs-check: ## Verify documentation is up to date
	@echo "$(CYAN)Checking documentation...$(RESET)"
	@./.project/scripts/docs/generate-all.sh > /dev/null 2>&1
	@if git diff --quiet docs/; then \
		echo "$(GREEN)✓$(RESET) Documentation is up to date"; \
	else \
		echo "$(CYAN)ℹ$(RESET) Documentation has changes (run: make docs)"; \
	fi

# ============================================================================
# Build & Deploy
# ============================================================================

build: ## Build all services
	@echo "$(CYAN)Building all services...$(RESET)"
	@echo "$(CYAN)Building Go services...$(RESET)"
	@for dir in $$(find services/go -name "go.mod" -type f 2>/dev/null | xargs -r dirname); do \
		echo "$(CYAN)  Building $$dir...$(RESET)"; \
		(cd $$dir && go build -o bin/$$(basename $$dir) ./...) || exit 1; \
	done
	@echo "$(CYAN)Building Python services...$(RESET)"
	@for dir in $$(find services/python -name "pyproject.toml" -o -name "setup.py" 2>/dev/null | xargs -r dirname | sort -u); do \
		echo "$(CYAN)  Building $$dir...$(RESET)"; \
		(cd $$dir && pip install -e . >/dev/null 2>&1) || true; \
	done
	@echo "$(GREEN)✅ All services built$(RESET)"

clean: ## Clean all build artifacts and reports
	@echo "$(CYAN)Cleaning build artifacts...$(RESET)"
	@find . -type f -name "*.pyc" -delete
	@find . -type d -name "__pycache__" -delete
	@find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "coverage.out" -delete
	@find . -type f -name "coverage.html" -delete
	@find . -type d -name "htmlcov" -exec rm -rf {} + 2>/dev/null || true
	@find services/go -type d -name "bin" -exec rm -rf {} + 2>/dev/null || true
	@rm -rf tmp/reports/ 2>/dev/null || true
	@echo "$(GREEN)✅ Cleanup complete$(RESET)"

deploy: ## Deploy services (CI only)
	@echo "$(CYAN)Deploying services...$(RESET)"
	@# TODO: Add deployment commands

# ============================================================================
# AI-Assisted Development (Low-level)
# ============================================================================

ai-start: ## Start AI-assisted development session (shows checkpoint + prompt)
	@./.project/scripts/session/start.sh

ai-step: ## Show step-by-step development prompt
	@echo "$(CYAN)📋 Step-by-Step Development Guide:$(RESET)"
	@echo ""
	@cat .ai/prompts/step-by-step.md

ai-checkpoint: ## Create session checkpoint
	@echo "$(CYAN)💾 Creating Session Checkpoint$(RESET)"
	@echo "=============================="
	@echo ""
	@DEVELOPER=$$(git config user.name | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g'); \
	DATE=$$(date +%Y-%m-%d); \
	SESSIONS_DIR=".ai/sessions/$$DEVELOPER/$$DATE"; \
	mkdir -p $$SESSIONS_DIR; \
	SESSION_NUM=1; \
	while [ -f "$$SESSIONS_DIR/session-$$SESSION_NUM.md" ]; do \
		SESSION_NUM=$$((SESSION_NUM + 1)); \
	done; \
	CHECKPOINT_FILE="$$SESSIONS_DIR/session-$$SESSION_NUM.md"; \
	echo "$(CYAN)Creating:$(RESET) $$CHECKPOINT_FILE"; \
	echo ""; \
	echo "$(CYAN)📋 Session End Prompt:$(RESET)"; \
	echo ""; \
	cat .ai/prompts/session-end.md; \
	echo ""; \
	echo "════════════════════════════════════════════════════════════════"; \
	echo ""; \
	echo "$(CYAN)Checkpoint will be created at:$(RESET) $$CHECKPOINT_FILE"; \
	echo "$(CYAN)Template location:$(RESET) .ai/templates/session-checkpoint-template.md"

ai-history: ## Show recent AI session history
	@echo "$(CYAN)📚 Recent AI Sessions$(RESET)"
	@echo "====================="
	@echo ""
	@DEVELOPER=$$(git config user.name | tr '[:upper:]' '[:lower:]' | sed 's/ /-/g'); \
	SESSIONS_DIR=".ai/sessions/$$DEVELOPER"; \
	if [ -d "$$SESSIONS_DIR" ]; then \
		echo "$(CYAN)Sessions for $$DEVELOPER:$(RESET)"; \
		echo ""; \
		for file in $$(find $$SESSIONS_DIR -name "session-*.md" -type f 2>/dev/null | sort -r | head -5); do \
			DATE_DIR=$$(basename $$(dirname $$file)); \
			SESSION=$$(basename $$file); \
			echo "$(CYAN)📄 $$DATE_DIR/$$SESSION$(RESET)"; \
			echo "   Path: $$file"; \
			GOAL=$$(grep -m 1 "^## Session Goal" $$file -A 1 | tail -1); \
			if [ -n "$$GOAL" ]; then \
				echo "   Goal: $$GOAL"; \
			fi; \
			echo ""; \
		done; \
		TOTAL=$$(find $$SESSIONS_DIR -name "session-*.md" -type f 2>/dev/null | wc -l); \
		if [ $$TOTAL -gt 5 ]; then \
			echo "$(CYAN)... and $$(( $$TOTAL - 5 )) more$(RESET)"; \
		fi; \
	else \
		echo "$(CYAN)ℹ️  No sessions found for $$DEVELOPER$(RESET)"; \
	fi; \
	echo ""; \
	echo "$(CYAN)All developers:$(RESET)"; \
	for dev_dir in .ai/sessions/*/; do \
		if [ -d "$$dev_dir" ]; then \
			DEV_NAME=$$(basename $$dev_dir); \
			COUNT=$$(find $$dev_dir -name "session-*.md" -type f 2>/dev/null | wc -l); \
			echo "  • $$DEV_NAME: $$COUNT session(s)"; \
		fi; \
	done

# ============================================================================
# Session Management (High-level, User-friendly)
# ============================================================================

session-start: ai-start ## Start a new development session (recommended)

session-end: ## End current session (shows checklist and guides checkpoint creation)
	@./.project/scripts/session/end.sh

session-commit: ## Commit session work (add SKIP_VERIFY=1 to skip checks)
	@if [ "$(SKIP_VERIFY)" = "1" ]; then \
		echo "$(CYAN)⚠️  Skipping verification checks (SKIP_VERIFY=1)$(RESET)"; \
		SKIP_VERIFY=1 ./.project/scripts/session/commit.sh; \
	else \
		echo "$(CYAN)Running verification checks before commit...$(RESET)"; \
		$(MAKE) check && ./.project/scripts/session/commit.sh || (echo "$(CYAN)❌ Checks failed. Run: make session-commit SKIP_VERIFY=1$(RESET)" && exit 1); \
	fi

session-push: ## Push session work to remote (smart quality check: skips if working tree clean)
	@if [ "$(SKIP_VERIFY)" = "1" ]; then \
		echo "$(CYAN)⚠️  Skipping verification checks (SKIP_VERIFY=1)$(RESET)"; \
		git push --no-verify; \
	else \
		if [ -n "$$(git status --porcelain)" ]; then \
			echo "$(CYAN)⚠️  Uncommitted changes detected - running full verification...$(RESET)"; \
			$(MAKE) check && git push || (echo "$(CYAN)❌ Checks failed. Run: make session-push SKIP_VERIFY=1$(RESET)" && exit 1); \
		else \
			echo "$(GREEN)✅ Working tree clean - skipping quality checks (already verified in session-commit)$(RESET)"; \
			git push; \
		fi; \
	fi

session-pr: ## Create pull request with auto-generated content (BASE=main to override base branch)
	@./.project/scripts/session/create-pr.sh $(BASE)

# ============================================================================
# Convenience Commands
# ============================================================================

check: validate quality test docs-check ## Run all checks before commit (validate + quality + test + docs)
	@echo ""
	@echo "$(GREEN)✅ All checks passed! Ready to commit.$(RESET)"

pre-commit: check ## Alias for 'check' - run before committing

fix: quality-fix format ## Fix all auto-fixable issues
	@echo ""
	@echo "$(GREEN)✅ All fixes applied! Run 'make check' to verify.$(RESET)"

# ============================================================================
# Secrets Management (Infisical)
# ============================================================================

secrets-pull: ## Pull secrets from Infisical to .env
	@if [ ! -f ".env" ]; then \
		echo "$(CYAN)No .env file found. Run 'make setup' first.$(RESET)"; \
		exit 1; \
	fi
	@if ! grep -q "INFISICAL_TOKEN" .env 2>/dev/null; then \
		echo "$(CYAN)Infisical not configured. Run 'make setup' to configure.$(RESET)"; \
		exit 1; \
	fi
	@echo "$(CYAN)Pulling secrets from Infisical...$(RESET)"
	@. .env && infisical export \
		--token="$$INFISICAL_TOKEN" \
		--projectId="$$INFISICAL_PROJECT_ID" \
		--env="$${INFISICAL_ENV:-dev}" \
		--format=dotenv > .env.secrets 2>/dev/null && \
	while IFS= read -r line; do \
		[ -z "$$line" ] && continue; \
		case "$$line" in \#*) continue;; esac; \
		key=$$(echo "$$line" | cut -d= -f1); \
		case "$$key" in INFISICAL_*) continue;; esac; \
		if ! grep -q "^$$key=" .env 2>/dev/null; then \
			echo "$$line" >> .env; \
		fi; \
	done < .env.secrets && \
	rm .env.secrets && \
	echo "$(GREEN)✅ Secrets pulled and merged into .env$(RESET)" || \
	(echo "$(CYAN)Failed to pull secrets. Check your token and permissions.$(RESET)" && rm -f .env.secrets && exit 1)

secrets-show: ## Show Infisical configuration (no secrets displayed)
	@if [ -f ".env" ] && grep -q "INFISICAL_TOKEN" .env 2>/dev/null; then \
		echo "$(CYAN)Infisical Configuration:$(RESET)"; \
		grep "INFISICAL_PROJECT_ID" .env 2>/dev/null | sed 's/^/  /' || true; \
		grep "INFISICAL_ENV" .env 2>/dev/null | sed 's/^/  /' || true; \
		echo "  INFISICAL_TOKEN=***configured***"; \
	else \
		echo "$(CYAN)Infisical not configured. Run 'make setup' to configure.$(RESET)"; \
	fi

# ============================================================================
# Template Sync (pull updates from template repository)
# ============================================================================

sync-template: sync-template-check ## Check for template updates

sync-template-check: ## Check if template updates are available
	@./.project/scripts/sync/sync-template.sh check

sync-template-preview: ## Preview template changes before applying
	@./.project/scripts/sync/sync-template.sh preview

sync-template-apply: ## Apply template updates (preserves .project.yaml)
	@./.project/scripts/sync/sync-template.sh apply

sync-template-status: ## Show template sync configuration
	@./.project/scripts/sync/sync-template.sh status
