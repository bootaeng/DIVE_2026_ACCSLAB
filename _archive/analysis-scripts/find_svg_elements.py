import xml.etree.ElementTree as ET

tree = ET.parse(r"C:\Users\USER\Desktop\DIVE_2026\code\frontend-react\public\busan_subway_map.svg")
root = tree.getroot()

print("Root tag:", root.tag)
print("Root attrib:", root.attrib)

# Let's traverse the tree and find elements with id, class, or other attributes.
elements_with_id = []
elements_with_metadata = []

def traverse(node):
    # Check if node has 'id'
    node_id = node.get('id')
    if node_id:
        elements_with_id.append((node.tag, node_id, node.attrib))
    # Check if node has other attributes like data-*, name, etc.
    for key in node.attrib:
        if key.startswith('data-') or key == 'name':
            elements_with_metadata.append((node.tag, key, node.attrib[key], node.attrib))
            
    for child in node:
        traverse(child)

traverse(root)

print(f"\nTotal elements with id: {len(elements_with_id)}")
print("First 20 elements with id:")
for item in elements_with_id[:20]:
    print(item)

print(f"\nTotal elements with metadata: {len(elements_with_metadata)}")
print("First 20 elements with metadata:")
for item in elements_with_metadata[:20]:
    print(item)
