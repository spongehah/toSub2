#!/usr/bin/env bash
set -eu

root="$(cd "$(dirname "$0")" && pwd)"
pid_file="$root/tmp/tosub2.pid"
log_file="$root/run.log"
venv_dir="$root/.venv"

is_running() {
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "toSub2 已在运行，PID $(cat "$pid_file")"
    exit 0
  fi
  if [[ ! -x "$venv_dir/bin/python" ]]; then
    echo "未找到虚拟环境：$venv_dir"
    echo "请先运行：python3 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt"
    exit 1
  fi
  mkdir -p "$root/tmp"
  cd "$root"
  # shellcheck disable=SC1091
  source "$venv_dir/bin/activate"
  # 直接启动 node，确保 pid_file 记录的是服务进程本身，stop/restart 才能终止监听端口的进程
  TOSUB2_PYTHON="$venv_dir/bin/python" nohup node "$root/src/console-server.mjs" > "$log_file" 2>&1 &
  echo $! > "$pid_file"
  echo "toSub2 已启动，PID $(cat "$pid_file")"
  echo "日志：$log_file"
}

stop() {
  if ! is_running; then
    rm -f "$pid_file"
    echo "toSub2 未运行"
    exit 0
  fi
  local pid
  pid="$(cat "$pid_file")"
  kill "$pid"
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid"
  fi
  rm -f "$pid_file"
  echo "toSub2 已停止"
}

status() {
  if is_running; then
    echo "toSub2 正在运行，PID $(cat "$pid_file")"
  else
    echo "toSub2 未运行"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
