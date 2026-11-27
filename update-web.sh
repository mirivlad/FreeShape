#!/usr/bin/env bash
set -Eeuo pipefail

# Parse the whole function before git pull can replace this file.
main() {
    local root branch port name image backup old_running="" address="" attempt
    root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    cd "$root"
    port="${WEB_PORT:-8086}"
    name="${WEB_CONTAINER:-freeshape-web}"
    image="${WEB_IMAGE:-freeshape-web:local}"
    backup="$name-update-backup"

    if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
        echo "WEB_PORT должен быть от 1 до 65535." >&2
        return 1
    fi
    port=$((10#$port))
    command -v git >/dev/null
    command -v docker >/dev/null
    docker info >/dev/null
    branch="$(git symbolic-ref --quiet --short HEAD)" || {
        echo "Переключитесь на ветку experiment/browser-wasm." >&2
        return 1
    }
    if [[ "$branch" != "experiment/browser-wasm" ]]; then
        echo "Ожидается ветка experiment/browser-wasm, текущая: $branch." >&2
        return 1
    fi
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Есть локальные изменения. Сохраните их перед обновлением." >&2
        return 1
    fi
    if docker container inspect "$backup" >/dev/null 2>&1; then
        echo "Найден резервный контейнер $backup. Проверьте его перед повторным запуском." >&2
        return 1
    fi
    if docker container inspect "$name" >/dev/null 2>&1; then
        local compose_project
        compose_project="$(docker container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$name")"
        if [[ -n "$compose_project" && "$compose_project" != "<no value>" ]]; then
            echo "Контейнер $name управляется Compose/Portainer. Обновите его через соответствующий стек." >&2
            return 1
        fi
    fi

    echo "Обновление репозитория..."
    git pull --ff-only origin "$branch"
    echo "Сборка Docker-образа..."
    docker build -f webcad/Dockerfile -t "$image" .

    # Retain the old container until the new one answers its healthcheck.
    if docker container inspect "$name" >/dev/null 2>&1; then
        old_running="$(docker container inspect --format '{{.State.Running}}' "$name")"
        docker rename "$name" "$backup"
        if [[ "$old_running" == true ]] && ! docker stop "$backup" >/dev/null; then
            docker rename "$backup" "$name"
            return 1
        fi
    fi

    rollback() {
        docker rm -f "$name" >/dev/null 2>&1 || true
        if [[ -n "$old_running" ]]; then
            docker rename "$backup" "$name" || return 1
            if [[ "$old_running" == true ]]; then
                docker start "$name" >/dev/null || return 1
            fi
        fi
    }
    trap 'echo "Обновление прервано." >&2; rollback || echo "Не удалось автоматически восстановить контейнер." >&2; exit 130' INT TERM
    echo "Запуск контейнера..."
    if ! docker run -d --name "$name" --restart unless-stopped -p "$port:8080" "$image" >/dev/null; then
        echo "Не удалось запустить контейнер." >&2
        rollback || echo "Не удалось автоматически восстановить контейнер." >&2
        return 1
    fi
    for ((attempt=0; attempt<30; attempt++)); do
        if docker exec "$name" wget -q -O /dev/null http://127.0.0.1:8080/healthz; then
            break
        fi
        sleep 1
    done
    if (( attempt == 30 )); then
        echo "Новый контейнер не прошёл проверку запуска." >&2
        docker logs --tail 30 "$name" >&2 || true
        rollback || echo "Не удалось автоматически восстановить контейнер." >&2
        return 1
    fi
    trap - INT TERM
    if [[ -n "$old_running" ]]; then
        docker rm "$backup" >/dev/null
    fi

    # ip route get only consults the local routing table; it sends no packets.
    if command -v ip >/dev/null; then
        address="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1);exit}}' || true)"
    fi
    if [[ -z "$address" ]] && command -v hostname >/dev/null; then
        address="$(hostname -I 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+\./ && $i !~ /^127\./){print $i;exit}}' || true)"
    fi
    printf '\nFreeShape Web запущен.\n'
    printf 'На этом ПК: http://localhost:%s/\n' "$port"
    if [[ -n "$address" && "$address" != 127.* ]]; then
        printf 'В локальной сети: http://%s:%s/\n' "$address" "$port"
    fi
    if [[ -n "${WEB_URL:-}" ]]; then
        printf 'Внешний адрес: %s\n' "$WEB_URL"
    fi
}
main "$@"
exit
