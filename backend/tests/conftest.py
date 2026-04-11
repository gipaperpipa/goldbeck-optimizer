"""
Shared fixtures for Goldbeck Optimizer test suite.

Run with:  cd backend && python -m pytest tests/ -v
"""
import sys
import os

# Ensure `app` package is importable when running from backend/
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
