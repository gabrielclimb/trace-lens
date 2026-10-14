IMAGE ?= ghcr.io/gabrielclimb/trace-lens
TAG   ?= local

.PHONY: open serve demo fixtures test docker-build docker-run local-trace

open:            ## Open the app straight from disk (no server needed)
	open index.html

serve:           ## Serve on http://localhost:8080 with Python
	python3 -m http.server 8080

demo:            ## Regenerate the fictional demo trace (data/sample-trace.{json,js})
	python3 tests/make_demo_trace.py

fixtures:        ## Generate test fixtures + oracle outputs from the demo trace
	python3 tests/make_fixtures.py
	for f in synthetic-5k errors; do \
	  { printf 'window.TV_SAMPLE_TRACE = '; cat tests/fixtures/$$f.json; printf ';\nwindow.TV_SAMPLE_NAME = "%s.json";\n' $$f; } > tests/fixtures/$$f.js; \
	done
	python3 tests/run_oracle.py

test: fixtures   ## Core tests + cross-check against the independent Python oracle
	node tests/core.test.js
	node tests/compare.js

local-trace:     ## Auto-load your own trace: make local-trace TRACE=~/Downloads/trace.json
	@test -n "$(TRACE)" || (echo "usage: make local-trace TRACE=path/to/trace.json" && exit 1)
	{ printf 'window.TV_LOCAL_TRACE = '; cat "$(TRACE)"; printf ';\nwindow.TV_LOCAL_NAME = "%s";\n' "$$(basename "$(TRACE)")"; } > data/local-trace.js
	@echo "wrote data/local-trace.js (gitignored)"

docker-build:    ## Build the image locally
	docker build -t $(IMAGE):$(TAG) .

docker-run:      ## Run the image on http://localhost:8080
	docker run --rm -p 8080:8080 $(IMAGE):$(TAG)
