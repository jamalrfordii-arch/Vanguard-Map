response = max(0, log2(depth_center) - log2(depth_neighbor))
shade = exp(-sum(responses) * edlStrength)