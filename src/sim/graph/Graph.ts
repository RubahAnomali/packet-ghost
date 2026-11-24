export interface GNode {
  id: number;
}
export interface GEdge {
  id: number;
  a: number;
  b: number;
}

/** Undirected graph with adjacency lists. Node and edge ids are their array indices. */
export class Graph<N extends GNode, E extends GEdge> {
  readonly nodes: N[] = [];
  readonly edges: E[] = [];
  private readonly adj: E[][] = [];

  addNode(n: N): N {
    if (n.id !== this.nodes.length) throw new Error('node id must equal its index');
    this.nodes.push(n);
    this.adj.push([]);
    return n;
  }

  /** Returns false (and adds nothing) for self-loops and duplicates. */
  addEdge(e: E): boolean {
    if (e.a === e.b || this.edgeBetween(e.a, e.b)) return false;
    if (e.id !== this.edges.length) throw new Error('edge id must equal its index');
    this.edges.push(e);
    this.adj[e.a]!.push(e);
    this.adj[e.b]!.push(e);
    return true;
  }

  edgesOf(id: number): readonly E[] {
    return this.adj[id]!;
  }

  neighbors(id: number): number[] {
    return this.adj[id]!.map((e) => (e.a === id ? e.b : e.a));
  }

  edgeBetween(a: number, b: number): E | undefined {
    return this.adj[a]?.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  }

  other(e: E, id: number): number {
    return e.a === id ? e.b : e.a;
  }

  degree(id: number): number {
    return this.adj[id]!.length;
  }
}
