import random

from app.services.optimizer.chromosome import Chromosome, Gene


def tournament_select(
    population: list[Chromosome],
    fitness_scores: list[float],
    k: int = 5,
) -> Chromosome:
    """Tournament selection: pick k random individuals, return the fittest."""
    indices = random.sample(range(len(population)), min(k, len(population)))
    best_idx = max(indices, key=lambda i: fitness_scores[i])
    return population[best_idx]


def crossover(parent_a: Chromosome, parent_b: Chromosome) -> Chromosome:
    """Uniform crossover with variable-length handling."""
    max_len = max(len(parent_a.genes), len(parent_b.genes))
    min_len = min(len(parent_a.genes), len(parent_b.genes))

    # Decide child length
    child_len = random.randint(min_len, max_len)
    child_genes = []

    for i in range(child_len):
        if i < len(parent_a.genes) and i < len(parent_b.genes):
            # Both parents have this gene — uniform crossover per field
            ga = parent_a.genes[i]
            gb = parent_b.genes[i]
            child_genes.append(Gene(
                x=ga.x if random.random() < 0.5 else gb.x,
                y=ga.y if random.random() < 0.5 else gb.y,
                width=ga.width if random.random() < 0.5 else gb.width,
                depth=ga.depth if random.random() < 0.5 else gb.depth,
                rotation=ga.rotation if random.random() < 0.5 else gb.rotation,
                stories=ga.stories if random.random() < 0.5 else gb.stories,
            ))
        elif i < len(parent_a.genes):
            child_genes.append(_clone_gene(parent_a.genes[i]))
        elif i < len(parent_b.genes):
            child_genes.append(_clone_gene(parent_b.genes[i]))

    return Chromosome(genes=child_genes)


def mutate(
    chromosome: Chromosome,
    mutation_rate: float = 0.15,
    mutation_sigma: float = 0.1,
    bounds: tuple = (0, 0, 100, 100),
    max_stories: int = 5,
) -> Chromosome:
    """Mutate each gene field with given probability and magnitude.

    mutation_rate: probability of mutating each field
    mutation_sigma: standard deviation of Gaussian perturbation (increases when stagnating)
    """
    new_genes = []
    for gene in chromosome.genes:
        new_gene = Gene(
            x=_mutate_val(gene.x, mutation_rate, mutation_sigma),
            y=_mutate_val(gene.y, mutation_rate, mutation_sigma),
            width=_mutate_val(gene.width, mutation_rate, mutation_sigma),
            depth=_mutate_val(gene.depth, mutation_rate, mutation_sigma),
            rotation=_mutate_val(gene.rotation, mutation_rate, mutation_sigma),
            stories=_mutate_val(gene.stories, mutation_rate, mutation_sigma),
        )
        new_genes.append(new_gene)

    # Occasional complete gene reset (exploration, not just perturbation)
    if random.random() < mutation_rate * 0.3:
        idx = random.randint(0, len(new_genes) - 1)
        field = random.choice(["x", "y", "width", "depth", "rotation", "stories"])
        setattr(new_genes[idx], field, random.random())

    # Structural mutation: add or remove a building
    if random.random() < mutation_rate * 0.5:
        if len(new_genes) > 1 and random.random() < 0.5:
            new_genes.pop(random.randint(0, len(new_genes) - 1))
        else:
            new_genes.append(Gene(
                x=random.random(),
                y=random.random(),
                width=random.uniform(0.2, 0.8),
                depth=random.uniform(0.2, 0.8),
                rotation=random.random(),
                stories=random.random(),
            ))

    return Chromosome(genes=new_genes)


def _mutate_val(val: float, rate: float, sigma: float = 0.1) -> float:
    if random.random() < rate:
        val += random.gauss(0, sigma)
        val = max(0.0, min(1.0, val))
    return val


def _clone_gene(gene: Gene) -> Gene:
    return Gene(
        x=gene.x, y=gene.y,
        width=gene.width, depth=gene.depth,
        rotation=gene.rotation, stories=gene.stories,
    )
