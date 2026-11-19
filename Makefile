.PHONY: build-sandbox

build-sandbox:
	docker build -t harness-sandbox:latest ./sandbox-image
