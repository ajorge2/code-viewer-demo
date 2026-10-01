import com.github.gumtreediff.actions.Diff;
import com.github.gumtreediff.actions.model.Action;
import com.github.gumtreediff.actions.model.Addition;
import com.github.gumtreediff.actions.model.TreeAddition;
import com.github.gumtreediff.actions.model.Update;
import com.github.gumtreediff.tree.Tree;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.IdentityHashMap;
import java.util.Set;

/**
 * Long-lived GumTree worker used by the Intent Algebra pilot.
 *
 * Protocol: one tab-separated request per line: request-id, before-path, after-path.
 * The worker emits one JSON object per request. Keeping the JVM warm avoids paying
 * GumTree's classpath and Tree-sitter initialization cost for every corpus row.
 */
public final class GumTreeBatch {
    private static final int MAX_LABEL_LENGTH = 240;
    private static final int MAX_CONTEXT_FRAMES = 3;
    private static final int MAX_CONTEXT_NODES = 48;
    private static final Set<String> CONTEXT_TYPES = Set.of(
            "argument_list", "arguments", "array", "assignment", "assignment_expression",
            "call", "call_expression", "class_definition", "dictionary", "function_definition",
            "keyword_argument", "list", "method_definition", "new_expression", "object", "pair",
            "variable_declarator");

    public static void main(String[] args) throws Exception {
        // Loading Run performs GumTree's annotated generator/matcher discovery once.
        Class.forName("com.github.gumtreediff.client.Run");

        BufferedReader input = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintWriter output = new PrintWriter(System.out, true, StandardCharsets.UTF_8);
        output.println("{\"ready\":true,\"protocol\":1}");

        String line;
        while ((line = input.readLine()) != null) {
            if (line.isBlank()) continue;
            String[] fields = line.split("\\t", -1);
            String id = fields.length > 0 ? fields[0] : "";
            if (fields.length != 3) {
                output.println(errorJson(id, "Expected request-id, before-path, and after-path"));
                continue;
            }

            try {
                Diff diff = Diff.compute(fields[1], fields[2]);
                output.println(diffJson(id, diff));
            } catch (Throwable error) {
                String message = error.getClass().getSimpleName() + ": "
                        + (error.getMessage() == null ? "unknown error" : error.getMessage());
                output.println(errorJson(id, message));
            }
        }
    }

    private static String diffJson(String id, Diff diff) {
        StringBuilder json = new StringBuilder(4096);
        int mappingCount = 0;
        for (Object ignored : diff.mappings) mappingCount += 1;

        json.append("{\"id\":").append(quote(id))
                .append(",\"ok\":true")
                .append(",\"source_nodes\":").append(countNodes(diff.src.getRoot()))
                .append(",\"destination_nodes\":").append(countNodes(diff.dst.getRoot()))
                .append(",\"source_error_nodes\":").append(countErrorNodes(diff.src.getRoot()))
                .append(",\"destination_error_nodes\":").append(countErrorNodes(diff.dst.getRoot()))
                .append(",\"mapping_count\":").append(mappingCount)
                .append(",\"actions\":[");

        boolean first = true;
        for (Action action : diff.editScript) {
            if (!first) json.append(',');
            first = false;
            appendAction(json, action, diff);
        }
        json.append("]}");
        return json.toString();
    }

    private static void appendAction(StringBuilder json, Action action, Diff diff) {
        String side = action.getName().startsWith("insert") ? "after" : "before";
        Tree node = action.getNode();

        json.append("{\"action\":").append(quote(action.getName()))
                .append(",\"side\":").append(quote(side))
                .append(",\"node\":");
        appendNode(json, node, true);
        json.append(",\"subtree\":");
        appendSubtree(json, node);
        json.append(",\"context_frames\":");
        appendContextFrames(json, node);

        if (action instanceof Addition addition) {
            json.append(",\"parent\":");
            appendNode(json, addition.getParent(), false);
            json.append(",\"position\":").append(addition.getPosition());
        } else if (action instanceof TreeAddition addition) {
            json.append(",\"parent\":");
            appendNode(json, addition.getParent(), false);
            json.append(",\"position\":").append(addition.getPosition());
        }

        if (action instanceof Update update) {
            json.append(",\"new_value\":").append(quote(trimLabel(update.getValue())));
        }

        Tree mapped = null;
        if ("before".equals(side) && diff.mappings.isSrcMapped(node)) {
            mapped = diff.mappings.getDstForSrc(node);
        } else if ("after".equals(side) && diff.mappings.isDstMapped(node)) {
            mapped = diff.mappings.getSrcForDst(node);
        }
        if (mapped != null) {
            json.append(",\"mapped_node\":");
            appendNode(json, mapped, false);
        }
        json.append('}');
    }

    private static void appendSubtree(StringBuilder json, Tree root) {
        appendSubtree(json, root, Integer.MAX_VALUE);
    }

    private static void appendSubtree(StringBuilder json, Tree root, int maximumNodes) {
        json.append('[');
        IdentityHashMap<Tree, Integer> ids = new IdentityHashMap<>();
        int nextId = 0;
        for (Tree node : root.preOrder()) {
            if (nextId >= maximumNodes) break;
            ids.put(node, nextId++);
        }

        boolean first = true;
        for (Tree node : root.preOrder()) {
            if (!ids.containsKey(node)) break;
            if (!first) json.append(',');
            first = false;
            Tree parent = node == root ? null : node.getParent();
            json.append("{\"id\":").append(ids.get(node))
                    .append(",\"parent\":").append(parent == null ? -1 : ids.getOrDefault(parent, -1))
                    .append(",\"type\":").append(quote(node.getType().name))
                    .append(",\"label\":").append(quote(trimLabel(node.getLabel())))
                    .append(",\"child_index\":").append(node.positionInParent())
                    .append('}');
        }
        json.append(']');
    }

    private static void appendContextFrames(StringBuilder json, Tree node) {
        json.append('[');
        Tree current = node;
        int distance = 0;
        int emitted = 0;
        boolean first = true;
        while (current != null && emitted < MAX_CONTEXT_FRAMES) {
            String type = current.getType() == null ? "" : current.getType().name;
            if (CONTEXT_TYPES.contains(type)) {
                if (!first) json.append(',');
                first = false;
                json.append("{\"type\":").append(quote(type))
                        .append(",\"distance\":").append(distance)
                        .append(",\"start\":").append(current.getPos())
                        .append(",\"end\":").append(current.getEndPos())
                        .append(",\"subtree\":");
                appendSubtree(json, current, MAX_CONTEXT_NODES);
                json.append('}');
                emitted += 1;
            }
            current = current.getParent();
            distance += 1;
        }
        json.append(']');
    }

    private static void appendNode(StringBuilder json, Tree node, boolean includeAncestors) {
        if (node == null) {
            json.append("null");
            return;
        }
        json.append("{\"type\":").append(quote(node.getType().name))
                .append(",\"label\":").append(quote(trimLabel(node.getLabel())))
                .append(",\"start\":").append(node.getPos())
                .append(",\"end\":").append(node.getEndPos())
                .append(",\"child_index\":").append(node.positionInParent());

        if (includeAncestors) {
            json.append(",\"ancestors\":[");
            Tree current = node;
            boolean first = true;
            while (current != null && current.getType() != null
                    && !current.getType().name.isEmpty()) {
                if (!first) json.append(',');
                first = false;
                json.append("{\"type\":").append(quote(current.getType().name))
                        .append(",\"start\":").append(current.getPos())
                        .append(",\"end\":").append(current.getEndPos())
                        .append(",\"child_index\":").append(current.positionInParent())
                        .append('}');
                current = current.getParent();
            }
            json.append(']');
        }
        json.append('}');
    }

    private static int countNodes(Tree root) {
        int count = 0;
        for (Tree ignored : root.preOrder()) count += 1;
        return count;
    }

    private static int countErrorNodes(Tree root) {
        int count = 0;
        for (Tree node : root.preOrder()) {
            String type = node.getType().name.toUpperCase();
            if (type.equals("ERROR") || type.equals("MISSING") || type.contains("ERROR")) count += 1;
        }
        return count;
    }

    private static String trimLabel(String value) {
        if (value == null || value.length() <= MAX_LABEL_LENGTH) return value == null ? "" : value;
        return value.substring(0, MAX_LABEL_LENGTH) + "…";
    }

    private static String errorJson(String id, String message) {
        return "{\"id\":" + quote(id) + ",\"ok\":false,\"error\":" + quote(message) + "}";
    }

    private static String quote(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        escaped.append('"');
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            switch (character) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) escaped.append(String.format("\\u%04x", (int) character));
                    else escaped.append(character);
                }
            }
        }
        return escaped.append('"').toString();
    }
}
