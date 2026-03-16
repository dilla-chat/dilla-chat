#!/bin/bash
# Test script for the auto-fix workflow
# This simulates what the GitHub Actions workflow does

set -e

echo "================================"
echo "Auto-Fix Workflow Test Script"
echo "================================"
echo

# Function to run client lint check
test_client_lint() {
    echo "→ Testing client lint..."
    cd client
    if npm run lint; then
        echo "✅ Client lint passed"
    else
        echo "❌ Client lint failed"
        echo "   Attempting auto-fix..."
        npm run lint -- --fix || true
        npm run format || true
        echo "   Checking if fixes worked..."
        if npm run lint; then
            echo "✅ Auto-fix successful!"
        else
            echo "⚠️  Manual intervention required"
        fi
    fi
    cd ..
}

# Function to run client build check
test_client_build() {
    echo
    echo "→ Testing client build..."
    cd client
    if npm run build; then
        echo "✅ Client build passed"
    else
        echo "❌ Client build failed"
        echo "   (Auto-fix would reinstall dependencies)"
    fi
    cd ..
}

# Function to run server tests
test_server_tests() {
    echo
    echo "→ Testing server tests..."
    cd server
    if make test; then
        echo "✅ Server tests passed"
    else
        echo "❌ Server tests failed"
        echo "   (Auto-fix would run: go mod tidy)"
    fi
    cd ..
}

# Function to run server build
test_server_build() {
    echo
    echo "→ Testing server build..."
    cd server
    if make build; then
        echo "✅ Server build passed"
    else
        echo "❌ Server build failed"
        echo "   (Auto-fix would run: go mod tidy && make build)"
    fi
    cd ..
}

# Main menu
echo "Select what to test:"
echo "  1) Client lint"
echo "  2) Client build"
echo "  3) Server tests"
echo "  4) Server build"
echo "  5) All of the above"
echo
read -p "Enter your choice (1-5): " choice

case $choice in
    1)
        test_client_lint
        ;;
    2)
        test_client_build
        ;;
    3)
        test_server_tests
        ;;
    4)
        test_server_build
        ;;
    5)
        test_client_lint
        test_client_build
        test_server_tests
        test_server_build
        ;;
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo
echo "================================"
echo "Test complete!"
echo "================================"
