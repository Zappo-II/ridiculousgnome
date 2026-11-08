# SPDX-FileCopyrightText: 2026 Zappo-II
# SPDX-License-Identifier: GPL-2.0-or-later

# RidiculousGnome: GNOME Shell extension + rg-helper (evdev input helper).
#
# `make` alone lists the targets. Targets for development need the full
# checkout; `install` / `uninstall` also work from the release tarball,
# which ships the built binary next to this Makefile.

UUID      := RidiculousGnome@Zappo-II.github.io
EXT_DIR   := gnome-extension/$(UUID)
HELPER    := helper
DIST      := $(HELPER)/dist
TARGET    := x86_64-unknown-linux-musl
BUS_NAME  := io.github.zappoii.RidiculousGnome.Helper
BUILD     := build
DOMAIN    := ridiculousgnome
POT       := po/$(DOMAIN).pot
PO_FILES  := $(wildcard po/*.po)
MO_FILES  := $(patsubst po/%.po,$(EXT_DIR)/locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))

# Release tarball: binary at the top; checkout: cargo's output
BIN       ?= $(firstword $(wildcard rg-helper) $(HELPER)/target/$(TARGET)/release/rg-helper)
VERSION   ?= $(shell cat VERSION 2>/dev/null || git describe --tags --always --dirty 2>/dev/null)
PKG_VERSION = $(patsubst v%,%,$(VERSION))
NFPM      ?= nfpm

# Install locations. LIBEXECDIR must be /usr/libexec on SELinux systems
# (Fedora): there the binary gets bin_t and may open /dev/input; under
# /usr/lib it stays init_t and is denied. Arch packages use /usr/lib/rg-helper.
DESTDIR   ?=
PREFIX    ?= /usr
LIBEXECDIR ?= $(PREFIX)/libexec
UNITDIR   ?= $(PREFIX)/lib/systemd/system
SYSUSERSDIR ?= $(PREFIX)/lib/sysusers.d
DBUSDIR   ?= $(PREFIX)/share/dbus-1

# Test VM over ssh (see CONTRIBUTING.md, "Test VMs")
VM_HOST   ?= gshell
VM_TMP    ?= /tmp/ridiculousgnome

EXT_ZIP   := $(BUILD)/$(UUID).shell-extension.zip
TARBALL   := $(BUILD)/rg-helper-$(PKG_VERSION)-x86_64.tar.gz
# Licenses of what is linked into the static binary (Rust std, musl, crates)
THIRD_PARTY := $(BUILD)/third-party

.DEFAULT_GOAL := help
.PHONY: help build helper extension pot translations check nested vm-install vm-remove vm-extension vm-reachable \
        install uninstall third-party dist check-version deb rpm packages arch aur release release-check clean

help: ## List the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z][a-z -]*:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: helper extension ## Build the helper binary and the extension zip

helper: ## Build the helper (static musl release binary)
	cd $(HELPER) && cargo build --release --target $(TARGET)

extension: ## Pack the extension zip (for extensions.gnome.org and releases)
	@mkdir -p $(BUILD)
	gnome-extensions pack --force --out-dir=$(BUILD) --podir=$(CURDIR)/po \
	    $(foreach f,$(filter-out extension.js prefs.js,$(notdir $(wildcard $(EXT_DIR)/*.js))),--extra-source=$(f)) \
	    --extra-source=icons --extra-source=sounds \
	    $(EXT_DIR)

pot: ## Update the translation template and merge it into po/*.po
	xgettext --from-code=UTF-8 -L JavaScript -k_ -kN_ --package-name=$(DOMAIN) --copyright-holder=Zappo-II \
	    --msgid-bugs-address=https://github.com/Zappo-II/ridiculousgnome/issues \
	    -o $(POT) $(sort $(wildcard $(EXT_DIR)/*.js))
	$(foreach po,$(PO_FILES),msgmerge --quiet --update --backup=none $(po) $(POT) && msgattrib --no-obsolete -o $(po) $(po);)

translations: $(MO_FILES) ## Compile translations into the extension source dir (nested shell, VM)

$(EXT_DIR)/locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	@mkdir -p $(dir $@)
	msgfmt --check -o $@ $<

check: ## Run helper tests and clippy, validate the settings schema
	cd $(HELPER) && cargo test --target $(TARGET) && cargo clippy --target $(TARGET)
	glib-compile-schemas --strict --dry-run $(EXT_DIR)/schemas
	$(foreach po,$(PO_FILES),msgfmt --check -o /dev/null $(po);)

nested: translations ## Run the extension in a nested GNOME Shell
	gnome-extension/run-nested.sh

# The VM gets what a user would download: the release tarball and the
# extension zip, copied over ssh into VM_TMP. Never a symlink or a shared
# folder: removing the extension in the guest (extension manager,
# gnome-extensions uninstall) deletes its directory, through a link the
# source on the host.
vm-install: dist vm-reachable ## Install the helper into the test VM from the release tarball (asks for the guest's sudo password)
	$(call vm-copy,$(TARBALL))
	ssh -t $(VM_HOST) 'cd $(VM_TMP) && tar xzf $(notdir $(TARBALL)) && sudo make -C rg-helper-$(PKG_VERSION) install'

vm-remove: dist vm-reachable ## Remove the helper from the test VM
	$(call vm-copy,$(TARBALL))
	ssh -t $(VM_HOST) 'cd $(VM_TMP) && tar xzf $(notdir $(TARBALL)) && sudo make -C rg-helper-$(PKG_VERSION) uninstall'

vm-extension: extension vm-reachable ## Install the extension zip into the test VM (then log out and in there)
	$(call vm-copy,$(EXT_ZIP))
	ssh $(VM_HOST) 'd="$$HOME/.local/share/gnome-shell/extensions/$(UUID)"; \
	    if [ -L "$$d" ]; then rm "$$d"; fi; \
	    gnome-extensions install --force $(VM_TMP)/$(notdir $(EXT_ZIP))'
	@echo "Installed. Log out and in in the VM to load it (GJS caches modules); first time also: gnome-extensions enable $(UUID)"

define vm-copy
ssh $(VM_HOST) 'rm -rf $(VM_TMP) && mkdir -p $(VM_TMP)'
scp -q $(1) $(VM_HOST):$(VM_TMP)/
endef

vm-reachable:
	@ssh -o BatchMode=yes -o ConnectTimeout=5 $(VM_HOST) true 2>/dev/null || { \
	    echo "no test VM: '$(VM_HOST)' not reachable by ssh." >&2; \
	    echo "Set up an ssh alias (CONTRIBUTING.md, \"Test VMs\"), or pass VM_HOST=..." >&2; exit 1; }

# The install itself is helper/install.sh (in the tarball: install.sh at
# the top), so systems without make get the same steps. Without DESTDIR it
# also creates the user, reloads systemd and D-Bus and (re)starts the helper.
INSTALL_SH := $(firstword $(wildcard install.sh) $(HELPER)/install.sh)
INSTALL_ENV = DESTDIR="$(DESTDIR)" PREFIX="$(PREFIX)" LIBEXECDIR="$(LIBEXECDIR)" UNITDIR="$(UNITDIR)" \
              SYSUSERSDIR="$(SYSUSERSDIR)" DBUSDIR="$(DBUSDIR)" BIN="$(BIN)"

install: ## Install the helper system-wide (as root; DESTDIR, PREFIX, LIBEXECDIR)
	$(INSTALL_ENV) ./$(INSTALL_SH)

uninstall: ## Remove the helper again (the system user rg-helper stays)
	$(INSTALL_ENV) ./$(INSTALL_SH) --uninstall

third-party: helper ## Write the licenses of everything linked into the helper binary
	packaging/third-party-licenses.py $(THIRD_PARTY)

dist: helper third-party ## Release tarball of the helper: binary, system files, install.sh, Makefile
	@rm -rf $(BUILD)/stage && mkdir -p $(BUILD)/stage/$(DIST)
	cp $(HELPER)/target/$(TARGET)/release/rg-helper $(HELPER)/install.sh Makefile README.md LICENSE $(THIRD_PARTY)/THIRD-PARTY-* $(BUILD)/stage/
	cp $(DIST)/* $(BUILD)/stage/$(DIST)/
	echo $(VERSION) > $(BUILD)/stage/VERSION
	tar -czf $(TARBALL) --transform 's|^stage|rg-helper-$(PKG_VERSION)|' -C $(BUILD) stage
	@rm -rf $(BUILD)/stage
	@echo $(TARBALL)

# Packages need a version like 1.2.3: a tag vX.Y.Z on the commit, or VERSION=...
check-version:
	@case "$(PKG_VERSION)" in [0-9]*.*) ;; *) \
	    echo "no package version from '$(VERSION)': tag the commit (vX.Y.Z) or pass VERSION=X.Y.Z" >&2; exit 1;; esac

deb rpm: helper third-party check-version ## Build the .deb / .rpm of the helper with nfpm
	@mkdir -p $(BUILD)
	VERSION=$(PKG_VERSION) \
	    $(NFPM) package --config packaging/nfpm.yaml --packager $@ --target $(BUILD)/

packages: deb rpm arch ## Build all helper packages

arch: dist check-version ## Build the Arch package (rg-helper-bin) from the release tarball, install with pacman -U
	@rm -rf $(BUILD)/arch && mkdir -p $(BUILD)/arch
	cp packaging/arch/PKGBUILD packaging/arch/rg-helper-bin.install $(TARBALL) $(BUILD)/arch/
	sed -i 's/^pkgver=.*/pkgver=$(PKG_VERSION)/' $(BUILD)/arch/PKGBUILD
	cd $(BUILD)/arch && PKGDEST=$(CURDIR)/$(BUILD) makepkg --force --skipchecksums

# Needs the tarball from `make dist` with the same VERSION
aur: check-version ## Set pkgver and the tarball's checksum in packaging/arch, write .SRCINFO
	@test -f $(TARBALL) || { echo "no $(TARBALL), run 'make dist VERSION=$(PKG_VERSION)' first" >&2; exit 1; }
	sed -i -e 's/^pkgver=.*/pkgver=$(PKG_VERSION)/' -e 's/^pkgrel=.*/pkgrel=1/' \
	    -e "s/^sha256sums=.*/sha256sums=('$$(sha256sum $(TARBALL) | cut -d' ' -f1)')/" packaging/arch/PKGBUILD
	cd packaging/arch && makepkg --printsrcinfo > .SRCINFO

release: ## Release VERSION=X.Y.Z: version, build, commit, tag, push, GitHub release (gh)
	packaging/release.sh $(PKG_VERSION)

release-check: ## Dry run of release: builds and shows the changes, then undoes them
	packaging/release.sh --dry-run $(PKG_VERSION)

clean: ## Remove build output
	rm -rf $(BUILD)
	cd $(HELPER) && cargo clean
