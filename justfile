set quiet
set unstable

[private]
default:
    just --list --justfile {{ justfile() }}

container-build:
    docker build -f container/Dockerfile -t jihchi/muxclaw:local .

container-run:
    docker run -it --rm \
      -v ./config/muxclaw:/home/deno/.config/muxclaw/ \
      -v ./config/pi:/home/deno/.pi/ \
      -v $(pwd)/workspace:/workspace \
      jihchi/muxclaw:local
