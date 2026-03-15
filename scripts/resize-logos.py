#!/usr/bin/env python3
"""
Generate all logo derivatives from root logo.png.

Single-source pattern: one high-res logo → multiple sizes for
favicon, sidebar, apple-icon, OG image, etc.

Usage:
    python3 scripts/resize-logos.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "logo.png"
DASHBOARD = ROOT / "packages" / "dashboard"
PUBLIC = DASHBOARD / "public"
APP = DASHBOARD / "src" / "app"


def resize_square(img: Image.Image, size: int) -> Image.Image:
    """Resize to square with high-quality Lanczos resampling."""
    return img.resize((size, size), Image.LANCZOS)


def create_og_image(img: Image.Image, width: int = 1200, height: int = 630) -> Image.Image:
    """Create OG image: centered logo on dark background."""
    bg = Image.new("RGBA", (width, height), (23, 23, 23, 255))  # #171717
    # Fit logo within 80% of height
    logo_size = int(height * 0.8)
    logo = resize_square(img, logo_size)
    x = (width - logo_size) // 2
    y = (height - logo_size) // 2
    bg.paste(logo, (x, y), logo)
    return bg.convert("RGB")


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(f"Source logo not found: {SOURCE}")

    img = Image.open(SOURCE).convert("RGBA")
    print(f"Source: {SOURCE} ({img.size[0]}x{img.size[1]})")

    PUBLIC.mkdir(parents=True, exist_ok=True)
    APP.mkdir(parents=True, exist_ok=True)

    # Public assets (sidebar, general use)
    derivatives = {
        PUBLIC / "logo-24.png": 24,
        PUBLIC / "logo-80.png": 80,
    }

    for path, size in derivatives.items():
        resize_square(img, size).save(path, "PNG")
        print(f"  {path.relative_to(ROOT)} ({size}x{size})")

    # App directory assets (Next.js metadata convention)

    # favicon — 32x32
    icon = resize_square(img, 32)
    icon_path = APP / "icon.png"
    icon.save(icon_path, "PNG")
    print(f"  {icon_path.relative_to(ROOT)} (32x32)")

    # apple-icon — 180x180
    apple = resize_square(img, 180)
    apple_path = APP / "apple-icon.png"
    apple.save(apple_path, "PNG")
    print(f"  {apple_path.relative_to(ROOT)} (180x180)")

    # favicon.ico — 16+32 multi-size
    ico_16 = resize_square(img, 16)
    ico_32 = resize_square(img, 32)
    ico_path = APP / "favicon.ico"
    ico_16.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32)], append_images=[ico_32])
    print(f"  {ico_path.relative_to(ROOT)} (16+32 multi-size)")

    # opengraph-image — 1200x630
    og = create_og_image(img)
    og_path = APP / "opengraph-image.png"
    og.save(og_path, "PNG")
    print(f"  {og_path.relative_to(ROOT)} (1200x630)")

    print("\nDone!")


if __name__ == "__main__":
    main()
