#!/bin/bash
set -e

echo "🔧 Setting up PrivatePerps development environment..."

# Fix Yarn GPG issue that blocks apt
echo "🔧 Fixing apt repositories..."
sudo rm -f /etc/apt/sources.list.d/yarn.list

# -----------------------------
# System dependencies
# -----------------------------
echo "📦 Installing system dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
    libudev-dev \
    libssl-dev \
    pkg-config \
    build-essential

# -----------------------------
# Rust (install only if missing)
# -----------------------------
echo "📦 Checking Rust..."
if ! command -v rustc &> /dev/null; then
  echo "Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source ~/.cargo/env
else
  echo "Rust already installed — skipping"
fi

# Ensure cargo env always loaded
grep -qxF 'source ~/.cargo/env' ~/.bashrc || echo 'source ~/.cargo/env' >> ~/.bashrc
source ~/.cargo/env || true

# -----------------------------
# Solana (install only if missing)
# -----------------------------
echo "📦 Checking Solana..."
if ! command -v solana &> /dev/null; then
  echo "Installing Solana..."
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
else
  echo "Solana already installed — skipping"
fi

# Ensure Solana in PATH
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
grep -qxF 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' ~/.bashrc || \
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc

# -----------------------------
# Anchor (install only if missing)
# -----------------------------
echo "📦 Checking Anchor..."
if ! command -v anchor &> /dev/null; then
  echo "Installing Anchor..."
  cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1 --locked --force --no-default-features
else
  echo "Anchor already installed — skipping"
fi

# -----------------------------
# Arcium (install only if missing)
# -----------------------------
echo "📦 Checking Arcium..."
if ! command -v arcium &> /dev/null; then
  echo "Installing Arcium..."
  bash -c "$(curl -sSf https://install.arcium.com)"
else
  echo "Arcium already installed — skipping"
fi

# -----------------------------
# Solana config
# -----------------------------
echo "⚙️ Configuring Solana..."
solana config set --url devnet

# -----------------------------
# Wallet (never overwrite)
# -----------------------------
if [ ! -f ~/.config/solana/id.json ]; then
    echo "🔑 Creating Solana wallet..."
    solana-keygen new --outfile ~/.config/solana/id.json --no-bip39-passphrase
else
    echo "✅ Existing wallet found — not overwriting"
fi

# -----------------------------
# Final info
# -----------------------------
echo ""
echo "✅ Setup complete!"
echo ""
rustc --version || true
solana --version || true
anchor --version || true
arcium --version || true
echo ""
echo "Your wallet address:"
solana address || true