#!/bin/bash
set -e

echo "🔧 Setting up PrivatePerps development environment..."

# Fix Yarn GPG issue that blocks apt
echo "🔧 Fixing apt repositories..."
sudo rm -f /etc/apt/sources.list.d/yarn.list

# Install system dependencies
echo "📦 Installing system dependencies..."
sudo apt-get update && sudo apt-get install -y \
    libudev-dev \
    libssl-dev \
    pkg-config \
    build-essential

# Install Rust
echo "📦 Installing Rust..."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# Install Solana
echo "📦 Installing Solana..."
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Add paths permanently to bashrc
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
echo 'source ~/.cargo/env' >> ~/.bashrc

# Install Anchor (with no-default-features to avoid hidapi/libudev issues)
echo "📦 Installing Anchor..."
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.32.1 --locked --force --no-default-features

# Install Arcium
echo "📦 Installing Arcium..."
bash -c "$(curl -sSf https://install.arcium.com)"

# Configure Solana to devnet
echo "⚙️ Configuring Solana..."
solana config set --url devnet

# Create wallet only if none exists
if [ ! -f ~/.config/solana/id.json ]; then
    echo "🔑 Creating Solana wallet..."
    solana-keygen new --outfile ~/.config/solana/id.json --no-bip39-passphrase
else
    echo "✅ Existing wallet found — not overwriting"
fi

echo ""
echo "✅ Setup complete!"
echo ""
rustc --version
solana --version
anchor --version
arcium --version
echo ""
echo "Your wallet address:"
solana address
