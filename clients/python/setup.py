from setuptools import setup, find_packages

setup(
    name="lens-py",
    version="0.1.0",
    description="Python client for the Lens Stellar price indexer API",
    packages=find_packages(),
    python_requires=">=3.9",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
    ],
)
