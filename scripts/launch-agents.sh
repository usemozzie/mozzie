#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# Mozzie — Multi-Agent Build Launcher
# ═══════════════════════════════════════════════════════════════
#
# This script orchestrates 4 Claude Code agents to build the
# Mozzie app in parallel where possible.
#
# Dependency graph:
#   Task A (scaffold) ──┬──→ Task B (PTY/terminals) ──┬──→ Task D (orchestration)
#                       └──→ Task C (tickets/UI)  ────┘
#
# Usage:
#   ./scripts/launch-agents.sh              # Run all tasks sequentially with parallel B+C
#   ./scripts/launch-agents.sh --task a     # Run only Task A
#   ./scripts/launch-agents.sh --task b     # Run only Task B (assumes A is done)
#   ./scripts/launch-agents.sh --task c     # Run only Task C (assumes A is done)
#   ./scripts/launch-agents.sh --task d     # Run only Task D (assumes A, B, C are done)
#   ./scripts/launch-agents.sh --parallel   # Run B and C in parallel (assumes A is done)
#   ./scripts/launch-agents.sh --resume d   # Resume from Task D (skip A, B, C)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$PROJECT_ROOT/agents"
LOG_DIR="$PROJECT_ROOT/.mozzie-build-logs"

mkdir -p "$LOG_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log_info() {
  echo -e "${CYAN}[$(timestamp)]${NC} ${GREEN}INFO${NC}  $1"
}

log_warn() {
  echo -e "${CYAN}[$(timestamp)]${NC} ${YELLOW}WARN${NC}  $1"
}

log_error() {
  echo -e "${CYAN}[$(timestamp)]${NC} ${RED}ERROR${NC} $1"
}

log_task() {
  echo -e "${CYAN}[$(timestamp)]${NC} ${BLUE}TASK${NC}  $1"
}

# ── Verify Claude Code is available ──
check_claude() {
  if ! command -v claude &> /dev/null; then
    log_error "Claude Code CLI not found. Install it first:"
    echo "  npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  log_info "Claude Code CLI found: $(which claude)"
}

# ── Run a single agent task ──
run_task() {
  local task_name="$1"
  local task_file="$2"
  local log_file="$LOG_DIR/${task_name}.log"

  log_task "Starting ${task_name}..."
  log_info "Prompt: ${task_file}"
  log_info "Log: ${log_file}"

  # Run Claude Code with the task prompt
  # --print mode for non-interactive execution
  # Pipe the full prompt file as input
  cd "$PROJECT_ROOT"
  
  claude -p "$(cat "$task_file")" \
    --allowedTools "Bash(command:*),Read,Write,Edit" \
    --output-format stream-json \
    2>&1 | tee "$log_file"

  local exit_code=${PIPESTATUS[0]}

  if [ $exit_code -eq 0 ]; then
    log_task "${task_name} completed successfully ✓"
  else
    log_error "${task_name} failed with exit code ${exit_code}"
    log_error "Check log: ${log_file}"
    return $exit_code
  fi
}

# ── Task runners ──
run_task_a() {
  run_task "Task-A-Scaffold" "$AGENTS_DIR/task-a-scaffold.md"
}

run_task_b() {
  run_task "Task-B-PTY-Terminals" "$AGENTS_DIR/task-b-pty-terminals.md"
}

run_task_c() {
  run_task "Task-C-Tickets-UI" "$AGENTS_DIR/task-c-tickets-ui.md"
}

run_task_d() {
  run_task "Task-D-Orchestration" "$AGENTS_DIR/task-d-orchestration.md"
}

run_parallel_bc() {
  log_task "Starting Tasks B and C in parallel..."

  run_task_b &
  local pid_b=$!

  run_task_c &
  local pid_c=$!

  log_info "Task B PID: $pid_b"
  log_info "Task C PID: $pid_c"
  log_info "Waiting for both to complete..."

  local failed=0

  wait $pid_b || { log_error "Task B failed"; failed=1; }
  wait $pid_c || { log_error "Task C failed"; failed=1; }

  if [ $failed -ne 0 ]; then
    log_error "One or more parallel tasks failed. Check logs in $LOG_DIR"
    exit 1
  fi

  log_task "Tasks B and C both completed successfully ✓"
}

run_all() {
  log_info "═══════════════════════════════════════════"
  log_info "  Mozzie — Full Build Pipeline"
  log_info "═══════════════════════════════════════════"
  echo ""

  # Phase 1: Scaffolding (must complete first)
  log_info "Phase 1/3: Project Scaffolding"
  run_task_a
  echo ""

  # Phase 2: PTY + Tickets in parallel
  log_info "Phase 2/3: PTY Bridge + Ticket System (parallel)"
  run_parallel_bc
  echo ""

  # Phase 3: Integration (needs both B and C)
  log_info "Phase 3/3: Agent Orchestration & Integration"
  run_task_d
  echo ""

  log_info "═══════════════════════════════════════════"
  log_info "  Build complete! Run: cd apps/desktop && pnpm tauri dev"
  log_info "═══════════════════════════════════════════"
}

# ── Parse arguments ──
main() {
  check_claude

  case "${1:-}" in
    --task)
      case "${2:-}" in
        a) run_task_a ;;
        b) run_task_b ;;
        c) run_task_c ;;
        d) run_task_d ;;
        *) echo "Usage: $0 --task [a|b|c|d]"; exit 1 ;;
      esac
      ;;
    --parallel)
      run_parallel_bc
      ;;
    --resume)
      case "${2:-}" in
        b) run_task_b; run_task_d ;;
        c) run_task_c; run_task_d ;;
        bc) run_parallel_bc; run_task_d ;;
        d) run_task_d ;;
        *) echo "Usage: $0 --resume [b|c|bc|d]"; exit 1 ;;
      esac
      ;;
    --help|-h)
      echo "Mozzie Multi-Agent Build Launcher"
      echo ""
      echo "Usage:"
      echo "  $0                  Run full pipeline (A → B+C parallel → D)"
      echo "  $0 --task [a|b|c|d] Run a single task"
      echo "  $0 --parallel       Run B+C in parallel (assumes A done)"
      echo "  $0 --resume [b|c|bc|d]  Resume from a specific point"
      echo "  $0 --help           Show this help"
      ;;
    "")
      run_all
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run $0 --help for usage"
      exit 1
      ;;
  esac
}

main "$@"
