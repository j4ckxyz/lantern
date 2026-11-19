# Everyday commands. See AGENTS.md for what each part is.

PY ?= .venv/bin/python
PI ?=

.PHONY: setup test lint copy-check ui ui-test bundle dev fake deploy

setup:            ## a development environment: Python venv and the UI's packages
	python3 -m venv .venv && $(PY) -m pip install -q -e ".[dev]"
	cd ui && npm install

test: lint copy-check  ## everything that runs without hardware
	$(PY) -m pytest -q
	cd ui && npm test

lint:
	$(PY) -m pyflakes src tests
	bash -n device/install.sh device/build-bundle.sh device/kiosk.sh

copy-check:       ## British English copy has no em dashes, anywhere a person reads
	@! grep -rn --include='*.ts' --include='*.tsx' --include='*.css' --include='*.html' --include='*.md' --include='*.py' --include='*.sh' \
		$$(printf '\xe2\x80\x94') ui/src ui/index.html docs src device README.md AGENTS.md PLAN.md \
		|| (echo "em dash found (above): use a colon, comma or full stop instead" && false)

ui:
	cd ui && npm run build

ui-test:
	cd ui && npm test && npm run e2e

fake:             ## a stand-in Hermes on 127.0.0.1:9119 (user ada, password pw)
	$(PY) -m lantern fakehermes --port 9119

dev:              ## the service in development mode; open the Vite dev server (cd ui && npm run dev)
	LANTERN_HOME=/tmp/lantern-dev $(PY) -m lantern run --dev

bundle:
	bash device/build-bundle.sh

deploy: bundle    ## make deploy PI=desk  (over Tailscale SSH; installs and restarts the desk)
	@test -n "$(PI)" || (echo "usage: make deploy PI=<desk's tailnet name>" && false)
	f=$$(ls -t dist/lantern-*-arm64.tar.zst | head -n1); \
	scp "$$f" device/install.sh $(PI):/tmp/ && \
	ssh $(PI) "sudo bash /tmp/install.sh --bundle /tmp/$$(basename $$f) --yes"
