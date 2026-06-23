set quiet
set unstable

[private]
default:
    just --list --justfile {{ justfile() }}

build_docker_image:
    docker build -f container/Dockerfile -t jihchi/muxclaw:local .
