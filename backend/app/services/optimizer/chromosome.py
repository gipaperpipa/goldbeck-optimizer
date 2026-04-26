from dataclasses import dataclass


@dataclass
class Gene:
    """A single building gene with normalized (0-1) values."""
    x: float       # position x (normalized within buildable bounds)
    y: float       # position y (normalized within buildable bounds)
    width: float   # building width (normalized)
    depth: float   # building depth (normalized)
    rotation: float  # rotation (normalized, maps to -22.5 to +22.5 deg)
    stories: float   # number of stories (normalized, maps to 1..max_stories)
    # Phase 8.5/8.6: Staffelgeschoss flag. > 0.5 → SG enabled.
    # Allowed at any story count ≥ 1 — Goldbeck routinely builds
    # 1-storey + SG (Bungalow + Penthouse) and 2-storey + SG. The GA
    # picks SG when it gives more Wohnfläche while still fitting the §6
    # envelope inside the parcel.
    has_staffel: float = 0.0


@dataclass
class Chromosome:
    """Variable-length chromosome encoding 1-N buildings."""
    genes: list[Gene]

    @property
    def num_buildings(self) -> int:
        return len(self.genes)


def decode_gene(
    gene: Gene,
    bounds: tuple[float, float, float, float],
    max_stories: int,
    min_dim: float = 30.0,
    max_dim: float = 200.0,
) -> dict:
    """Decode a gene into actual building parameters."""
    min_x, min_y, max_x, max_y = bounds
    stories = max(1, min(max_stories, int(gene.stories * max_stories) + 1))
    has_staffel = bool(gene.has_staffel >= 0.5 and stories >= 1)
    return {
        "x": min_x + gene.x * (max_x - min_x),
        "y": min_y + gene.y * (max_y - min_y),
        "width": min_dim + gene.width * (max_dim - min_dim),
        "depth": min_dim + gene.depth * (max_dim - min_dim),
        "rotation": gene.rotation * 45.0 - 22.5,
        "stories": stories,
        "has_staffel": has_staffel,
    }
